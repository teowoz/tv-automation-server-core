/// <reference types="web-bluetooth" />

import { EventEmitter } from 'events'
import { ExternalController } from '../external-device'
import { TouchPadPosition, GearControllerButton, GearVRController } from 'gear-vr-controller'
import { PrompterViewInner, PrompterNotification } from '../../PrompterView'

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
    constructor(ec: ExternalController, gear: GearVRController, view: PrompterViewInner) {
        this._ec = ec
        this._gear = gear
        this._touch = new TouchHandler()
        this._touch.connectToController(gear)

        const { t } = view.props;

        gear.on('connect', () => {
            PrompterNotification.show('info', t("Controller connected."))
            PrompterNotification.hideAfter(500)
        })
        gear.on('disconnect', () => {
            PrompterNotification.show('warning', t("Controller disconnected!"))
        })

        gear.on('buttondown', (button: GearControllerButton) => {
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
            if (!gear.buttonStates.get(GearControllerButton.TRIGGER)) {
                ec.nudge(ev.deltaY)
            }
        })
        this._touch.on('movestop', () => {
            ec.stopManualScrolling()
        })
        this._touch.on('tap', () => {
            ec.stopManualScrolling()
        })
        gear.on('touchrelease', () => {
            ec.continueScrolling()
        })
        this._touch.on('edgerotate', (ev) => {
            if (gear.buttonStates.get(GearControllerButton.TRIGGER)) {
                ec.changeScrollingSpeed(ev.deltaAngle)
            }
        })
    }
}

export function connectGearVRController (ec: ExternalController, view: PrompterViewInner): void {
    let gear = new GearVRController()
    new GearToExternalControllerMediator(ec, gear, view);

    const { t } = view.props;

    const triggerConnect = async () => {
        if (!gear.connected) {
            try {
                PrompterNotification.show('progress', t("Connecting ..."))
                await gear.connect()
            } catch (err) {
                console.error(err)
                PrompterNotification.show('warning', t("Connecting failed!"))
            }
        }
    }

    // Register the connect function to be triggered by user
    window.document.addEventListener('click', triggerConnect)
    window.document.addEventListener('keypress', (ev) => {
        if (ev.keyCode==13) {
            triggerConnect()
        }
    });

    // But first try to connect without user gesture, sometimes browsers allow it
    (async () => {
        try {
            await gear.connect()
        } catch (err) {
            PrompterNotification.show('notice', t("Ready to connect."))
        }
    })()
    
}
