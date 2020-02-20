/// <reference types="web-bluetooth" />

import { EventEmitter } from 'events'
import { ExternalController } from '../external-device'

enum GearControllerButton {
    TRIGGER = 'trigger',
    TOUCHPAD = 'touchpad',
    BACK = 'back',
    HOME = 'home',
    VOL_UP = 'volUp',
    VOL_DOWN = 'volDown'
}

interface TouchPadPosition {
    x: number
    y: number
}

declare interface GearVRController {
    on(event: 'buttondown', listener: (button: GearControllerButton) => void): this
    on(event: 'buttonup', listener: (button: GearControllerButton) => void): this
    on(event: 'touch', listener: (position: TouchPadPosition) => void): this
    on(event: 'touchrelease', listener: () => void): this
    on(event: string, listener: Function): this
}

class GearVRController extends EventEmitter {
    protected static readonly UUIDs = {
        PRIMARY_SERVICE: "4f63756c-7573-2054-6872-65656d6f7465",
        WRITE_CHARACTERISTIC: "c8c51726-81bc-483b-a052-f7a14ea3d282",
        NOTIFY_CHARACTERISTIC: "c8c51726-81bc-483b-a052-f7a14ea3d281"
    }
    protected static readonly Commands = {
        POWER_OFF: [0, 0],
        SENSORS_MODE: [1, 0],
        KEEP_ALIVE: [4, 0],
        VR_MODE: [8, 0]
    }
    protected readonly _bluetoothDeviceFilters = [
        {namePrefix: 'Gear VR'}
    ]

    protected _gattServer: BluetoothRemoteGATTServer | null = null
    protected _primaryService: BluetoothRemoteGATTService | null = null
    protected _notifyCharacteristic: BluetoothRemoteGATTCharacteristic | null = null
    protected _writeCharacteristic: BluetoothRemoteGATTCharacteristic | null = null

    buttonStates: Map<GearControllerButton, boolean> = new Map()
    touchPosition: TouchPadPosition | null = null
    get touched() {
        return this.touchPosition!=null
    }

    transient: boolean = false

    async connect(): Promise<void> {
        this._ensureNotTransient()
        this.transient = true
        try {
            this._resetStates()

            if (navigator.bluetooth===undefined) {
                throw new Error("Browser does not support Bluetooth")
            }
            if (!(await navigator.bluetooth.getAvailability())) {
                throw new Error("Bluetooth not available")
            }
            const device: BluetoothDevice = await navigator.bluetooth.requestDevice({ filters: this._bluetoothDeviceFilters,
                optionalServices: [GearVRController.UUIDs.PRIMARY_SERVICE] })
            if (device.gatt===undefined) {
                throw new Error("Bluetooth GATT not available")
            }
            console.info("User chose device, connecting...")

            this._gattServer = await device.gatt.connect()
            console.debug("GATT server ready")
            
            this._primaryService = await this._gattServer.getPrimaryService(GearVRController.UUIDs.PRIMARY_SERVICE)
            this._notifyCharacteristic = await this._primaryService.getCharacteristic(GearVRController.UUIDs.NOTIFY_CHARACTERISTIC)
            this._writeCharacteristic = await this._primaryService.getCharacteristic(GearVRController.UUIDs.WRITE_CHARACTERISTIC)
            console.debug("Services & characteristics ready")

            this._notifyCharacteristic.addEventListener('characteristicvaluechanged', this._onNotificationReceived.bind(this))
            await this._notifyCharacteristic.startNotifications()
            console.debug("Started notifications")

            await this._subscribeToSensors()
            console.debug("Subscribed to sensors.")
            console.info("Connected")
        } finally {
            this.transient = false
        }
    }

    get connected(): boolean {
        return (this._writeCharacteristic!=null &&
            this._notifyCharacteristic!=null &&
            this._primaryService!=null &&
            this._gattServer!=null &&
            this._gattServer.connected)
    }

    protected _ensureConnected(): void {
        if (!this.connected) {
            throw new Error("Not connected!")
        }
    }
    protected _ensureNotTransient(): void {
        if (this.transient) {
            throw new Error("Now changing state! Try again later.")
        }
    }

    async disconnect(): Promise<void> {
        this.transient = true
        try {
            await this._runCommand(GearVRController.Commands.POWER_OFF)
        } finally {
            try {
                this._ensureConnected()
                this._gattServer!.disconnect()
            } finally {
                this._resetStates()
                this._writeCharacteristic = null
                this._notifyCharacteristic = null
                this._primaryService = null
                this._gattServer = null
                this.transient = false
            }
        }
    }

    protected async _runCommand(opcode: number[]): Promise<void> {
        this._ensureConnected()
        await this._writeCharacteristic!.writeValue(new Uint8Array(opcode))
    }

    protected _resetStates(): void {
        for (let btn of Object.values(GearControllerButton)) {
            this.buttonStates[btn] = false
        }
        this.touchPosition = null
    }

    protected async _subscribeToSensors(): Promise<void> {
        await this._runCommand(GearVRController.Commands.VR_MODE)
        await this._runCommand(GearVRController.Commands.SENSORS_MODE)
    }

    protected _onNotificationReceived(e): void {
        const { buffer } = e.target.value;
        const bytes = new Uint8Array(buffer);

        // handle buttons:
        const s = (button: GearControllerButton, bit_offset: number): void => {
            this._setButtonState(button, (bytes[58] & (1 << bit_offset)) != 0)
        }
        s(GearControllerButton.TRIGGER, 0)
        s(GearControllerButton.HOME, 1)
        s(GearControllerButton.BACK, 2)
        s(GearControllerButton.TOUCHPAD, 3)
        s(GearControllerButton.VOL_UP, 4)
        s(GearControllerButton.VOL_DOWN, 5)

        // get raw coordinates in range 0..315:
        const rawX = ((bytes[54] & 0xF) << 6) | ((bytes[55] & 0xFC) >> 2)
        const rawY = ((bytes[55] & 0x3) << 8) |  (bytes[56] & 0xFF)

        if (rawX && rawY) {
            // convert to range -1..1:
            this.touchPosition = {x: rawX / 157.5 - 1.0, y: rawY / 157.5 - 1.0}
            this.emit('touch', this.touchPosition)
        } else {
            const wasTouched = this.touched
            this.touchPosition = null
            if (wasTouched) {
                this.emit('touchrelease')
            }
        }

    }

    protected _setButtonState(button: GearControllerButton, pressed: boolean): void {
        let prev: boolean = this.buttonStates[button]
        if (prev != pressed) {
            if (pressed) {
                this.emit('buttondown', button)
            } else {
                this.emit('buttonup', button)
            }
            this.buttonStates[button] = pressed
        }
    }
}

class TouchPadMoveEvent {
    protected static readonly EPSILON = 0.001
    deltaX: number
    deltaY: number
    constructor(deltaX: number, deltaY: number) {
        this.deltaX = deltaX
        this.deltaY = deltaY
    }
    get isSignificant(): boolean {
        return Math.abs(this.deltaX) > TouchPadMoveEvent.EPSILON || Math.abs(this.deltaY) > TouchPadMoveEvent.EPSILON
    }
}

interface PolarCoordinates {
    radius: number
    angle: number
}

interface TouchPadEdgeRotateEvent {
    radius: number
    deltaAngle: number
}

declare interface TouchHandler {
    on(event: 'move', listener: (e: TouchPadMoveEvent) => void): this
    on(event: 'movestop', listener: () => void): this
    on(event: 'tap', listener: () => void): this
    on(event: 'edgerotate', listener: (e: TouchPadEdgeRotateEvent) => void): this
    on(event: string, listener: Function): this
}

class TouchHandler extends EventEmitter {
    protected _prevPosition: TouchPadPosition | null = null
    protected _wasMoving: boolean = false
    protected _movingStoppedTimeout: number | null = null
    handleTouch(pos: TouchPadPosition) {
        if (this._prevPosition!=null) {
            const moveEvent = new TouchPadMoveEvent(pos.x - this._prevPosition.x,
                                                    pos.y - this._prevPosition.y)
            if (!moveEvent.isSignificant) {
                return
            }
            this._wasMoving = true
            this.emit('move', moveEvent)
            this._delayMoveStop()
            if (this.listenerCount('edgerotate')) {
                const { radius, angle } = this._positionToPolar(pos)
                if (radius > 0.7) {
                    const { angle: prevAngle } = this._positionToPolar(this._prevPosition)
                    let deltaAngle: number = angle - prevAngle
                    if (deltaAngle >= Math.PI) {
                        deltaAngle -= 2*Math.PI
                    } else if (deltaAngle <= -Math.PI) {
                        deltaAngle += 2*Math.PI
                    }
                    this.emit('edgerotate', { radius, deltaAngle })
                }
            }
        } else {
            // strictly speaking, it shouldn't be here because there was no move
            // but we want to treat touching the touchpad without moving as movestop
            this._delayMoveStop()
        }
        this._prevPosition = pos
    }
    handleRelease() {
        this._clearMovingStoppedTimeout()
        if (!this._wasMoving) {
            this.emit('tap')
        }
        this._wasMoving = false
        this._prevPosition = null
    }
    _delayMoveStop() {
        this._clearMovingStoppedTimeout()
        this._movingStoppedTimeout = window.setTimeout(() => {
            this.emit('movestop')
            this._movingStoppedTimeout = null
        }, 150)
    }
    _clearMovingStoppedTimeout() {
        if (this._movingStoppedTimeout!=null) {
            window.clearTimeout(this._movingStoppedTimeout)
            this._movingStoppedTimeout = null
        }
    }
    _positionToPolar(pos: TouchPadPosition): PolarCoordinates {
        return {
            radius: Math.sqrt(pos.x*pos.x + pos.y*pos.y),
            angle: Math.atan2(pos.y, pos.x)
        }
    }
    connectToController(controller: GearVRController) {
        controller.on('touch', this.handleTouch.bind(this))
        controller.on('touchrelease', this.handleRelease.bind(this))
    }
}

class GearToExternalControllerMediator {
    protected _ec: ExternalController
    protected _gear: GearVRController
    protected _touch: TouchHandler
    constructor(ec: ExternalController, gear: GearVRController) {
        this._ec = ec
        this._gear = gear
        this._touch = new TouchHandler()
        this._touch.connectToController(gear)
        gear.on('buttondown', (button: GearControllerButton) => {
            console.debug('Button down: ' + button)
            switch(button) {
                case GearControllerButton.VOL_DOWN:
                    ec.startScrollingDown()
                    break
                case GearControllerButton.VOL_UP:
                    ec.startScrollingUp()
                    break
                case GearControllerButton.BACK:
                    ec.stopScrolling()
                    break
                case GearControllerButton.HOME:
                    ec.moveToLive()
                    break
                default:
            }
        })
        this._touch.on('move', (ev) => {
            console.debug('Move on touchpad', ev)
            if (!gear.buttonStates[GearControllerButton.TRIGGER]) {
                ec.nudge(ev.deltaY)
            }
        })
        this._touch.on('movestop', () => {
            console.debug('move stop')
            ec.stopManualScrolling()
        })
        this._touch.on('tap', () => {
            console.debug('touchpad tapped')
            ec.stopManualScrolling()
        })
        gear.on('touchrelease', () => {
            console.debug('touch release')
            ec.continueScrolling()
        })
        this._touch.on('edgerotate', (ev) => {
            console.debug('Rotate on touchpad edge', ev)
            if (gear.buttonStates[GearControllerButton.TRIGGER]) {
                ec.changeScrollingSpeed(ev.deltaAngle)
            }
        })
    }
}

export function connectGearVRController (ec: ExternalController): void {
    let gear = new GearVRController()
    new GearToExternalControllerMediator(ec, gear);

    (async () => {
        try {
            await gear.connect()
        } catch (err) {
            console.warn("connect to controller failed, user action required?", err)
            window.document.addEventListener('click', () => {
                if (!gear.connected) {
                    gear.connect()
                }
            })
        }
    })()
    
}
