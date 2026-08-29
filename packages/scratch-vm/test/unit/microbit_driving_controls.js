const test = require('tap').test;

const Accelerator = require('../../src/extensions/scratch3_microbit__accelerator');
const Brake = require('../../src/extensions/scratch3_microbit__brake');
const Handle = require('../../src/extensions/scratch3_microbit__handle');

const runtime = (keys = new Set()) => ({
    registerPeripheralExtension: () => {},
    ioDevices: {
        keyboard: {
            getKeyIsDown: key => keys.has(key)
        }
    }
});

const setBackAngle = (extension, degrees) => {
    extension._peripheral.isConnected = () => true;
    extension._peripheral._sensors.tiltY = degrees * 10;
};

const setRightAngle = (extension, degrees) => {
    extension._peripheral.isConnected = () => true;
    extension._peripheral._sensors.tiltX = degrees * 10;
};

test('pedal extensions expose only their driving blocks', t => {
    const acceleratorOpcodes = new Accelerator(runtime()).getInfo().blocks.map(block => block.opcode);
    const brakeOpcodes = new Brake(runtime()).getInfo().blocks.map(block => block.opcode);

    t.same(acceleratorOpcodes, [
        'setMaximumSpeed',
        'waitForReleasedAngle',
        'waitForPressedAngle',
        'updateAcceleration',
        'getAcceleration'
    ]);
    t.same(brakeOpcodes, [
        'setStoppingStrength',
        'waitForReleasedAngle',
        'waitForPressedAngle',
        'updateDeceleration',
        'getDeceleration'
    ]);
    t.end();
});

test('accelerator calibrates pedal strength and smooths acceleration', t => {
    const accelerator = new Accelerator(runtime());
    t.equal(accelerator.isReady(), false);
    accelerator.setMaximumSpeed({MAX_SPEED: 150, SECONDS: 15});

    setBackAngle(accelerator, 20);
    accelerator.recordReleasedAngle();
    setBackAngle(accelerator, -20);
    accelerator.recordPressedAngle();
    t.equal(accelerator.isReady(), true);

    setBackAngle(accelerator, 20);
    t.equal(accelerator._getPedalStrength(), 0);
    setBackAngle(accelerator, 0);
    t.equal(accelerator._getPedalStrength(), 0.5);
    setBackAngle(accelerator, -20);
    t.equal(accelerator._getPedalStrength(), 1);

    accelerator.updateAcceleration({CURRENT_SPEED: 0});
    t.ok(accelerator.getAcceleration() > 0, 'the circular curve starts moving without jumping to its target');
    t.end();
});

test('released accelerator applies noticeable coasting resistance', t => {
    const accelerator = new Accelerator(runtime());
    accelerator.setMaximumSpeed({MAX_SPEED: 150, SECONDS: 15});
    setBackAngle(accelerator, 20);
    accelerator.recordReleasedAngle();
    setBackAngle(accelerator, -20);
    accelerator.recordPressedAngle();

    setBackAngle(accelerator, 20);
    accelerator.updateAcceleration({CURRENT_SPEED: 100});
    t.ok(accelerator.getAcceleration() < 0);
    for (let i = 0; i < 20; i++) accelerator.updateAcceleration({CURRENT_SPEED: 100});
    t.ok(accelerator.getAcceleration() < -4, 'coasting exceeds 4 km/h/s resistance at 100 km/h');
    t.end();
});

test('full accelerator follows a generalized cosine speed curve', t => {
    const accelerationAt = speed => {
        const accelerator = new Accelerator(runtime());
        accelerator.setMaximumSpeed({MAX_SPEED: 150, SECONDS: 15});
        setBackAngle(accelerator, 20);
        accelerator.recordReleasedAngle();
        setBackAngle(accelerator, -20);
        accelerator.recordPressedAngle();
        accelerator.updateAcceleration({CURRENT_SPEED: speed});
        return accelerator.getAcceleration();
    };

    const launch = accelerationAt(0);
    const middle = accelerationAt(60);
    const nearMaximum = accelerationAt(140);
    t.ok(middle > launch * 20, 'acceleration rises substantially after launch');
    t.ok(middle > 15 && middle < 17, 'mid-speed peak is derived from maximum speed and time');
    t.ok(nearMaximum < middle, 'acceleration fades near maximum speed');
    t.end();
});

test('acceleration curve reaches arbitrary configured speed at configured time', t => {
    const runFullAcceleration = (maximumSpeed, seconds) => {
        const accelerator = new Accelerator(runtime());
        accelerator.setMaximumSpeed({MAX_SPEED: maximumSpeed, SECONDS: seconds});
        setBackAngle(accelerator, 20);
        accelerator.recordReleasedAngle();
        setBackAngle(accelerator, -20);
        accelerator.recordPressedAngle();
        let speed = 0;
        for (let tick = 0; tick < seconds * 10; tick++) {
            accelerator.updateAcceleration({CURRENT_SPEED: speed});
            speed += accelerator.getAcceleration() * 0.1;
        }
        return speed;
    };

    t.ok(Math.abs(runFullAcceleration(150, 15) - 150) < 1e-8);
    t.ok(Math.abs(runFullAcceleration(200, 10) - 200) < 1e-8);
    t.end();
});

test('brake calibrates pedal strength and limits deceleration near zero speed', t => {
    const brake = new Brake(runtime());
    t.equal(brake.isReady(), false);
    brake.setStoppingStrength({STOPPING_SPEED: 100});

    setBackAngle(brake, 15);
    brake.recordReleasedAngle();
    setBackAngle(brake, -25);
    brake.recordPressedAngle();
    t.equal(brake.isReady(), true);
    t.equal(brake._getPedalStrength(), 1);

    brake.updateDeceleration({CURRENT_SPEED: 1});
    t.ok(brake.getDeceleration() > 0);
    t.ok(brake.getDeceleration() <= 10, '0.1 second update cannot pass below zero speed');
    t.end();
});

test('controls reject an insufficient pedal range', t => {
    const accelerator = new Accelerator(runtime());
    accelerator.setMaximumSpeed({MAX_SPEED: 150, SECONDS: 15});
    setBackAngle(accelerator, 10);
    accelerator.recordReleasedAngle();
    setBackAngle(accelerator, 13);
    accelerator.recordPressedAngle();

    t.equal(accelerator.isReady(), false);
    accelerator.updateAcceleration({CURRENT_SPEED: 0});
    t.equal(accelerator.getAcceleration(), 0);
    t.end();
});

test('pedals wait for a changed angle to remain stable for half a second', t => {
    const accelerator = new Accelerator(runtime());
    accelerator.setMaximumSpeed({MAX_SPEED: 150, SECONDS: 15});
    setBackAngle(accelerator, 20);
    accelerator.recordReleasedAngle();

    const util = {
        stackFrame: {},
        yield: () => {
            util.yielded = true;
        }
    };
    setBackAngle(accelerator, 0);
    accelerator.waitForPressedAngle({}, util);
    t.equal(util.yielded, true, 'the block waits when the new angle has only just been reached');
    t.equal(accelerator.isReady(), false);

    util.yielded = false;
    util.stackFrame.stableSince = Date.now() - 501;
    accelerator.waitForPressedAngle({}, util);
    t.equal(util.yielded, false, 'the block completes after the stable interval');
    t.equal(accelerator.isReady(), true);
    t.end();
});

test('pedals can wait for the released position without user confirmation', t => {
    const brake = new Brake(runtime());
    const util = {
        stackFrame: {},
        yield: () => {
            util.yielded = true;
        }
    };
    setBackAngle(brake, 15);
    brake.waitForReleasedAngle({}, util);
    t.equal(util.yielded, true);
    util.yielded = false;
    util.stackFrame.stableSince = Date.now() - 501;
    brake.waitForReleasedAngle({}, util);
    t.equal(util.yielded, false);
    t.equal(brake._releasedAngle, 15);
    t.end();
});

test('pedals use arrow keys as virtual angles when disconnected', t => {
    const completeWait = (extension, method) => {
        const util = {
            stackFrame: {},
            yielded: false,
            yield: () => {
                util.yielded = true;
            }
        };
        extension[method]({}, util);
        util.yielded = false;
        util.stackFrame.stableSince = Date.now() - 501;
        extension[method]({}, util);
    };

    const acceleratorKeys = new Set();
    const accelerator = new Accelerator(runtime(acceleratorKeys));
    accelerator.setMaximumSpeed({MAX_SPEED: 150, SECONDS: 15});
    completeWait(accelerator, 'waitForReleasedAngle');
    acceleratorKeys.add('up arrow');
    completeWait(accelerator, 'waitForPressedAngle');
    t.equal(accelerator.isReady(), true);
    t.equal(accelerator._getPedalStrength(), 1, 'up arrow fully presses the accelerator');
    acceleratorKeys.clear();
    t.equal(accelerator._getPedalStrength(), 0, 'releasing up arrow releases the accelerator');

    const brakeKeys = new Set();
    const brake = new Brake(runtime(brakeKeys));
    brake.setStoppingStrength({STOPPING_SPEED: 100});
    completeWait(brake, 'waitForReleasedAngle');
    brakeKeys.add('down arrow');
    completeWait(brake, 'waitForPressedAngle');
    t.equal(brake.isReady(), true);
    t.equal(brake._getPedalStrength(), 1, 'down arrow fully presses the brake');
    brakeKeys.clear();
    t.equal(brake._getPedalStrength(), 0, 'releasing down arrow releases the brake');
    t.end();
});

test('pedals keep their configured range after a micro:bit disconnects', t => {
    const acceleratorKeys = new Set(['up arrow']);
    const accelerator = new Accelerator(runtime(acceleratorKeys));
    accelerator.setMaximumSpeed({MAX_SPEED: 150, SECONDS: 15});
    setBackAngle(accelerator, 20);
    accelerator.recordReleasedAngle();
    setBackAngle(accelerator, -20);
    accelerator.recordPressedAngle();
    accelerator._peripheral.isConnected = () => false;
    t.equal(accelerator._getPedalStrength(), 1);

    const brakeKeys = new Set(['down arrow']);
    const brake = new Brake(runtime(brakeKeys));
    brake.setStoppingStrength({STOPPING_SPEED: 100});
    setBackAngle(brake, 15);
    brake.recordReleasedAngle();
    setBackAngle(brake, -25);
    brake.recordPressedAngle();
    brake._peripheral.isConnected = () => false;
    t.equal(brake._getPedalStrength(), 1);
    t.end();
});

test('handle exposes only waiting calibration and steering blocks', t => {
    const opcodes = new Handle(runtime()).getInfo().blocks.map(block => block.opcode);
    t.same(opcodes, [
        'waitForCenterAngle',
        'waitForRightAngle',
        'waitForLeftAngle',
        'getSteeringAmount'
    ]);
    t.end();
});

test('handle calibrates direction and normalizes steering amount', t => {
    const handle = new Handle(runtime());
    setRightAngle(handle, 5);
    handle.recordCenterAngle();
    setRightAngle(handle, -25);
    handle.recordRightAngle();
    setRightAngle(handle, 35);
    handle.recordLeftAngle();

    t.equal(handle.isReady(), true, 'opposite sides identify the rotation directions');
    setRightAngle(handle, 5);
    t.equal(handle.getSteeringAmount(), 0);
    setRightAngle(handle, -10);
    t.equal(handle.getSteeringAmount(), 50);
    setRightAngle(handle, 20);
    t.equal(handle.getSteeringAmount(), -50);
    setRightAngle(handle, -40);
    t.equal(handle.getSteeringAmount(), 100, 'values beyond the recorded right limit are clamped');
    t.end();
});

test('handle rejects positions recorded on the same side of center', t => {
    const handle = new Handle(runtime());
    setRightAngle(handle, 0);
    handle.recordCenterAngle();
    setRightAngle(handle, 20);
    handle.recordRightAngle();
    setRightAngle(handle, 30);
    handle.recordLeftAngle();

    t.equal(handle.isReady(), false);
    t.equal(handle.getSteeringAmount(), 0);
    t.end();
});

test('handle waits for stable center, right, and opposite left positions', t => {
    const handle = new Handle(runtime());
    const makeUtil = () => {
        const util = {
            stackFrame: {},
            yield: () => {
                util.yielded = true;
            }
        };
        return util;
    };
    const completeWait = (method, angle) => {
        const util = makeUtil();
        setRightAngle(handle, angle);
        handle[method]({}, util);
        util.yielded = false;
        util.stackFrame.stableSince = Date.now() - 501;
        handle[method]({}, util);
        return util;
    };

    completeWait('waitForCenterAngle', 5);
    completeWait('waitForRightAngle', -25);
    const wrongLeft = completeWait('waitForLeftAngle', -35);
    t.equal(wrongLeft.yielded, true, 'a second position on the right side keeps waiting');
    t.equal(handle.isReady(), false);

    const left = completeWait('waitForLeftAngle', 35);
    t.equal(left.yielded, false);
    t.equal(handle.isReady(), true);
    t.equal(handle.getSteeringAmount(), -100);
    t.end();
});

test('handle uses arrow keys as virtual angles when disconnected', t => {
    const keys = new Set();
    const handle = new Handle(runtime(keys));
    const completeWait = method => {
        const util = {
            stackFrame: {},
            yielded: false,
            yield: () => {
                util.yielded = true;
            }
        };
        handle[method]({}, util);
        util.yielded = false;
        util.stackFrame.stableSince = Date.now() - 501;
        handle[method]({}, util);
        return util;
    };

    completeWait('waitForCenterAngle');
    keys.add('right arrow');
    completeWait('waitForRightAngle');
    keys.delete('right arrow');
    keys.add('left arrow');
    completeWait('waitForLeftAngle');

    t.equal(handle.isReady(), true);
    t.equal(handle.getSteeringAmount(), -100, 'left arrow steers fully left');
    keys.delete('left arrow');
    keys.add('right arrow');
    t.equal(handle.getSteeringAmount(), 100, 'right arrow steers fully right');
    keys.add('left arrow');
    t.equal(handle.getSteeringAmount(), 0, 'pressing both arrows returns to center');
    keys.clear();
    t.equal(handle.getSteeringAmount(), 0, 'releasing both arrows returns to center');
    t.end();
});

test('handle keeps arrow-key directions after a configured micro:bit disconnects', t => {
    const keys = new Set();
    const handle = new Handle(runtime(keys));
    setRightAngle(handle, 5);
    handle.recordCenterAngle();
    setRightAngle(handle, -25);
    handle.recordRightAngle();
    setRightAngle(handle, 35);
    handle.recordLeftAngle();
    handle._peripheral.isConnected = () => false;

    keys.add('right arrow');
    t.equal(handle.getSteeringAmount(), 100);
    keys.clear();
    keys.add('left arrow');
    t.equal(handle.getSteeringAmount(), -100);
    t.end();
});
