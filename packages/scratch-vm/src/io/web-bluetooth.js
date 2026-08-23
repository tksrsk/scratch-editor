const Base64Util = require('../util/base64-util');

/**
 * BLE transport backed by the browser's Web Bluetooth API.
 * This implements the subset of the Scratch BLE transport used by micro:bit.
 */
class WebBluetooth {
    /**
     * @param {object} runtime runtime used to publish peripheral events
     * @param {string} extensionId ID of the extension using this transport
     * @param {object} peripheralOptions options passed to requestDevice
     * @param {function(): void} connectCallback called after GATT connects
     * @param {function(): void} resetCallback resets extension state after a lost connection
     */
    constructor (runtime, extensionId, peripheralOptions, connectCallback, resetCallback = null) {
        this._runtime = runtime;
        this._extensionId = extensionId;
        this._peripheralOptions = peripheralOptions;
        this._connectCallback = connectCallback;
        this._resetCallback = resetCallback;

        this._availablePeripherals = {};
        this._device = null;
        this._server = null;
        this._services = new Map();
        this._characteristics = new Map();
        this._notificationHandlers = new Map();
        this._connected = false;
        this._intentionalDisconnect = false;

        this._handleGattDisconnected = this._handleGattDisconnected.bind(this);

        // The constructor is reached synchronously from the Start Searching
        // button, preserving the user activation required by requestDevice().
        this.requestPeripheral();
    }

    /**
     * Open the browser device chooser for one device.
     * @returns {Promise<void>} resolves after a device is selected
     */
    requestPeripheral () {
        this._availablePeripherals = {};
        if (typeof navigator === 'undefined' || !navigator.bluetooth ||
            typeof navigator.bluetooth.requestDevice !== 'function') {
            this._handleRequestError();
            return Promise.resolve();
        }

        return navigator.bluetooth.requestDevice(this._peripheralOptions)
            .then(device => {
                this._device = device;
                device.addEventListener('gattserverdisconnected', this._handleGattDisconnected);

                this._availablePeripherals[device.id] = {
                    peripheralId: device.id,
                    name: device.name || 'micro:bit'
                };
                this._runtime.emit(
                    this._runtime.constructor.PERIPHERAL_LIST_UPDATE,
                    this._availablePeripherals
                );
            })
            .catch(error => {
                // Canceling the native chooser is equivalent to an empty scan.
                if (error && error.name === 'NotFoundError') {
                    this._runtime.emit(this._runtime.constructor.PERIPHERAL_SCAN_TIMEOUT);
                    return;
                }
                this._handleRequestError();
            });
    }

    /**
     * Connect to the device selected by requestPeripheral().
     * @param {string} id selected BluetoothDevice ID
     * @returns {Promise<void>} resolves after GATT connects
     */
    connectPeripheral (id) {
        if (!this._device || this._device.id !== id || !this._device.gatt) {
            this._handleRequestError();
            return Promise.resolve();
        }

        this._intentionalDisconnect = false;
        return this._device.gatt.connect()
            .then(server => {
                this._server = server;
                this._connected = true;
                this._runtime.emit(this._runtime.constructor.PERIPHERAL_CONNECTED);
                return this._connectCallback();
            })
            .catch(() => {
                this._handleRequestError();
            });
    }

    /** Disconnect intentionally from the selected device. */
    disconnect () {
        this._intentionalDisconnect = true;
        this._connected = false;
        this._removeNotificationHandlers();

        if (this._device) {
            this._device.removeEventListener('gattserverdisconnected', this._handleGattDisconnected);
            if (this._device.gatt && this._device.gatt.connected) this._device.gatt.disconnect();
        }

        this._server = null;
        this._services.clear();
        this._characteristics.clear();
        this._runtime.emit(this._runtime.constructor.PERIPHERAL_DISCONNECTED);
    }

    /** @returns {boolean} whether the GATT connection is active */
    isConnected () {
        return Boolean(this._connected && this._device && this._device.gatt && this._device.gatt.connected);
    }

    /**
     * Read a characteristic and optionally subscribe to notifications.
     * @param {number|string} serviceId GATT service UUID
     * @param {number|string} characteristicId GATT characteristic UUID
     * @param {boolean} startNotifications whether to subscribe to notifications
     * @param {function(string): void} onCharacteristicChanged callback receiving base64 data
     * @returns {Promise<void>} resolves when the characteristic is ready
     */
    read (serviceId, characteristicId, startNotifications = false, onCharacteristicChanged = null) {
        return this._getCharacteristic(serviceId, characteristicId)
            .then(characteristic => {
                if (!startNotifications) return Promise.resolve();

                const handler = event => {
                    if (!onCharacteristicChanged) return;
                    const value = event.target.value;
                    const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
                    onCharacteristicChanged(Base64Util.uint8ArrayToBase64(bytes));
                };
                characteristic.addEventListener('characteristicvaluechanged', handler);
                this._notificationHandlers.set(characteristic, handler);
                return characteristic.startNotifications();
            })
            .catch(error => {
                this.handleDisconnectError(error);
            });
    }

    /**
     * Write bytes to a characteristic.
     * @param {number|string} serviceId GATT service UUID
     * @param {number|string} characteristicId GATT characteristic UUID
     * @param {string|Uint8Array} message bytes, normally base64 encoded
     * @param {string} encoding message encoding
     * @param {boolean} withResponse prefer a write with response
     * @returns {Promise<void>} resolves after writing
     */
    write (serviceId, characteristicId, message, encoding = null, withResponse = null) {
        const data = encoding === 'base64' ? Base64Util.base64ToUint8Array(message) : message;
        return this._getCharacteristic(serviceId, characteristicId)
            .then(characteristic => {
                if (withResponse && typeof characteristic.writeValueWithResponse === 'function') {
                    return characteristic.writeValueWithResponse(data);
                }
                if (withResponse === false && typeof characteristic.writeValueWithoutResponse === 'function') {
                    return characteristic.writeValueWithoutResponse(data);
                }
                return characteristic.writeValue(data);
            })
            .catch(error => {
                this.handleDisconnectError(error);
            });
    }

    /** Handle an unexpected disconnect. */
    handleDisconnectError (/* error */) {
        if (!this._connected) return;

        this._connected = false;
        this._removeNotificationHandlers();
        if (this._device && this._device.gatt && this._device.gatt.connected) this._device.gatt.disconnect();
        this._server = null;
        this._services.clear();
        this._characteristics.clear();

        if (this._resetCallback) this._resetCallback();
        this._runtime.emit(this._runtime.constructor.PERIPHERAL_CONNECTION_LOST_ERROR, {
            message: 'Scratch lost connection to',
            extensionId: this._extensionId
        });
    }

    _handleGattDisconnected (event) {
        if (!this._intentionalDisconnect) this.handleDisconnectError(event);
    }

    _handleRequestError () {
        this._runtime.emit(this._runtime.constructor.PERIPHERAL_REQUEST_ERROR, {
            message: 'Scratch could not connect to',
            extensionId: this._extensionId
        });
    }

    _getService (serviceId) {
        if (!this._server || !this._connected) {
            return Promise.reject(new Error('Bluetooth device is not connected'));
        }
        if (this._services.has(serviceId)) return Promise.resolve(this._services.get(serviceId));
        return this._server.getPrimaryService(serviceId).then(service => {
            this._services.set(serviceId, service);
            return service;
        });
    }

    _getCharacteristic (serviceId, characteristicId) {
        const key = `${serviceId}:${characteristicId}`;
        if (this._characteristics.has(key)) return Promise.resolve(this._characteristics.get(key));
        return this._getService(serviceId)
            .then(service => service.getCharacteristic(characteristicId))
            .then(characteristic => {
                this._characteristics.set(key, characteristic);
                return characteristic;
            });
    }

    _removeNotificationHandlers () {
        for (const [characteristic, handler] of this._notificationHandlers) {
            characteristic.removeEventListener('characteristicvaluechanged', handler);
        }
        this._notificationHandlers.clear();
    }
}

module.exports = WebBluetooth;
