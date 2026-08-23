const test = require('tap').test;

const WebBluetooth = require('../../src/io/web-bluetooth');

class Runtime {
    static get PERIPHERAL_LIST_UPDATE () {
        return 'PERIPHERAL_LIST_UPDATE';
    }

    static get PERIPHERAL_SCAN_TIMEOUT () {
        return 'PERIPHERAL_SCAN_TIMEOUT';
    }

    static get PERIPHERAL_CONNECTED () {
        return 'PERIPHERAL_CONNECTED';
    }

    static get PERIPHERAL_DISCONNECTED () {
        return 'PERIPHERAL_DISCONNECTED';
    }

    static get PERIPHERAL_REQUEST_ERROR () {
        return 'PERIPHERAL_REQUEST_ERROR';
    }

    static get PERIPHERAL_CONNECTION_LOST_ERROR () {
        return 'PERIPHERAL_CONNECTION_LOST_ERROR';
    }

    constructor () {
        this.events = [];
    }

    emit (name, data) {
        this.events.push({name, data});
    }
}

const setNavigator = bluetooth => {
    Object.defineProperty(global, 'navigator', {
        configurable: true,
        value: {bluetooth}
    });
};

const flushPromises = () => new Promise(resolve => setImmediate(resolve));

test('selects, connects, receives notifications, writes, and disconnects', async t => {
    const listeners = new Map();
    const characteristicListeners = new Map();
    let writtenValue;

    const characteristic = {
        addEventListener: (name, handler) => characteristicListeners.set(name, handler),
        removeEventListener: name => characteristicListeners.delete(name),
        startNotifications: () => Promise.resolve(),
        writeValueWithResponse: value => {
            writtenValue = value;
            return Promise.resolve();
        }
    };
    const service = {
        getCharacteristic: () => Promise.resolve(characteristic)
    };
    const server = {
        getPrimaryService: () => Promise.resolve(service)
    };
    const gatt = {
        connected: false,
        connect: () => {
            gatt.connected = true;
            return Promise.resolve(server);
        },
        disconnect: () => {
            gatt.connected = false;
        }
    };
    const device = {
        id: 'device-1',
        name: 'BBC micro:bit',
        gatt,
        addEventListener: (name, handler) => listeners.set(name, handler),
        removeEventListener: name => listeners.delete(name)
    };
    setNavigator({
        requestDevice: options => {
            t.same(options, {filters: [{services: [0xf005]}]}, 'passes discovery filters to the browser');
            return Promise.resolve(device);
        }
    });

    const runtime = new Runtime();
    let connected = false;
    const transport = new WebBluetooth(
        runtime,
        'microbit',
        {filters: [{services: [0xf005]}]},
        () => {
            connected = true;
        }
    );
    await flushPromises();

    t.match(runtime.events[0], {
        name: Runtime.PERIPHERAL_LIST_UPDATE,
        data: {'device-1': {peripheralId: 'device-1', name: 'BBC micro:bit'}}
    }, 'publishes the device selected in the browser chooser');

    await transport.connectPeripheral('device-1');
    t.equal(connected, true, 'runs the extension connect callback');
    t.equal(transport.isConnected(), true, 'reports an active connection');

    let notification;
    await transport.read(0xf005, 'rx', true, value => {
        notification = value;
    });
    const bytes = new Uint8Array([1, 2, 3]);
    characteristicListeners.get('characteristicvaluechanged')({
        target: {value: new DataView(bytes.buffer)}
    });
    t.equal(notification, 'AQID', 'converts notification bytes to base64');

    await transport.write(0xf005, 'tx', 'AQID', 'base64', true);
    t.same(Array.from(writtenValue), [1, 2, 3], 'decodes base64 before writing');

    transport.disconnect();
    t.equal(transport.isConnected(), false, 'disconnects GATT');
    t.equal(listeners.has('gattserverdisconnected'), false, 'removes the device listener');
    t.equal(characteristicListeners.has('characteristicvaluechanged'), false, 'removes notification listeners');

    delete global.navigator;
});

test('treats canceling the chooser as an empty scan', async t => {
    const canceled = new Error('User cancelled');
    canceled.name = 'NotFoundError';
    setNavigator({requestDevice: () => Promise.reject(canceled)});

    const runtime = new Runtime();
    new WebBluetooth(runtime, 'microbit', {filters: []}, () => {}); // eslint-disable-line no-new
    await flushPromises();

    t.equal(runtime.events.length, 1);
    t.equal(runtime.events[0].name, Runtime.PERIPHERAL_SCAN_TIMEOUT);
    delete global.navigator;
});

test('reports unsupported browsers as a request error', async t => {
    setNavigator(null);
    const runtime = new Runtime();
    new WebBluetooth(runtime, 'microbit', {filters: []}, () => {}); // eslint-disable-line no-new
    await flushPromises();

    t.equal(runtime.events.length, 1);
    t.equal(runtime.events[0].name, Runtime.PERIPHERAL_REQUEST_ERROR);
    delete global.navigator;
});
