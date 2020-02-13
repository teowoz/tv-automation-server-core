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

interface TouchPadEvent {
    x: number
    y: number
}

declare interface GearVRController {
    on(event: 'buttondown', listener: (button: GearControllerButton) => void): this
    on(event: 'buttonup', listener: (button: GearControllerButton) => void): this
    on(event: 'touchpadmove', listener: (e: TouchPadEvent) => void): this
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
            console.debug("Subscribed to sensors. Connect done.")
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
            this._ensureConnected()
            this._gattServer!.disconnect()
            this._writeCharacteristic = null
            this._notifyCharacteristic = null
            this._primaryService = null
            this._gattServer = null
            this.transient = false
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
    }

    protected async _subscribeToSensors(): Promise<void> {
        this._ensureConnected()
        await this._runCommand(GearVRController.Commands.VR_MODE)
        await this._runCommand(GearVRController.Commands.SENSORS_MODE)
    }

    protected _onNotificationReceived(e): void {
        const { buffer } = e.target.value;
        const bytes = new Uint8Array(buffer);

        const s = (button: GearControllerButton, bit_offset: number): void => {
            this._setButtonState(button, (bytes[58] & (1 << bit_offset)) != 0)
        }
        s(GearControllerButton.TRIGGER, 0)
        s(GearControllerButton.HOME, 1)
        s(GearControllerButton.BACK, 2)
        s(GearControllerButton.TOUCHPAD, 3)
        s(GearControllerButton.VOL_UP, 4)
        s(GearControllerButton.VOL_DOWN, 5)
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

class GearToExternalControllerMediator {
    protected _ec: ExternalController
    protected _gear: GearVRController
    constructor(ec: ExternalController, gear: GearVRController) {
        this._ec = ec
        this._gear = gear
        gear.on('buttondown', (button: GearControllerButton) => {
            console.debug('Button down: ' + button)
            switch(button) {
                case GearControllerButton.VOL_DOWN:
                    ec.startScrollingDown();
                    break;
                case GearControllerButton.VOL_UP:
                    ec.startScrollingUp();
                    break;
                case GearControllerButton.BACK:
                    ec.stopScrolling();
                    break;
                default:
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
            window.document.addEventListener('click', async () => {
                if (!gear.connected) {
                    gear.connect()
                }
            })
        }
    })()
    
}
