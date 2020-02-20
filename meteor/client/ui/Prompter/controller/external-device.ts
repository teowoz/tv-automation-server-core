import { ControllerAbstract, PrompterControlInterface, LowPassFilter } from './lib'
import { PrompterViewInner } from '../PrompterView'
import { NotificationCenter, Notification, NoticeLevel } from '../../../lib/notifications/notifications'

const LOCALSTORAGE_MODE = 'prompter-controller-external'
/**
 * This class handles control of the prompter using an external (not using ControllerAbstract events) controller.
 * It handles scrolling animation.
 * The actual controller calls methods of this class.
 */
export class ExternalController extends ControllerAbstract implements PrompterControlInterface {

	private _destroyed: boolean = false

	private _mouseKeyDown: { [button: string]: number } = {}

	private _prompterView: PrompterViewInner

	/** scroll speed, in pixels per frame */
	private _autoScrollSpeed: number = 4
	private _scrollSpeedTarget: number = 4
	private _scrollSpeedCurrent: number = 0
	private _scrollingDown: boolean = false
	private _scrollingUp: boolean = false
	private _scrollingManual: boolean = false
	private _updateSpeedHandle: number | null = null
	private _scrollPosition: number = 0
	private _scrollRest: number = 0
	private _noMovement: number = 0
	private _disableMouseWheel : boolean = false // TODO: make changeable
	private _toNudge: number = 0
	private _nudgeLowPass: LowPassFilter = new LowPassFilter(0.8)

	private _scrollDownDelta: number = 0
	private _scrollDownDeltaTracker: number = 0

	private _nextPausePosition: number | null = null
	private _lastWheelTime: number = 0

	nudgeMultiplier : number = -200
	manualScrollingMultiplier : number = -30
	manualScrollingInertia: number = 0.95 // 0-1 range, 1 for no resistance (scroll forever once started)

	constructor(view: PrompterViewInner) {
		super(view)

		this._prompterView = view

	}
	public destroy() {
		this._destroyed = true
	}
	public onKeyDown(e: KeyboardEvent) {
		// Nothing
		if (
			e.code === 'KeyP' &&
			e.ctrlKey
		) {
			e.preventDefault() // Prevent print-dialogue
		} else if (
			e.code === 'F5'
		) {
			e.preventDefault() // Prevent reload of page
		}
	}
	public onKeyUp(e: KeyboardEvent) {
		// Nothing
	}
	public onMouseKeyDown(e: MouseEvent) {
		// Nothing
	}
	public onMouseKeyUp(e: MouseEvent) {
		// Nothing
	}
	public onWheel(e: WheelEvent) {
		// Nothing
		if (this._disableMouseWheel) {
			e.preventDefault();
		}
	}

	public startScrollingDown() {
		this._scrollingDown = true
		this._scrollingUp = false
		this.triggerStartSpeedScrolling()
	}
	public startScrollingUp() {
		this._scrollingUp = true
		this.triggerStartSpeedScrolling()
	}
	public stopScrolling() {
		this._scrollingUp = false
		this._scrollingDown = false
		this._scrollingManual = false
		this.triggerStartSpeedScrolling()
	}
	public stopScrollingDown() {
		this.stopScrolling()
	}
	public stopScrollingUp() {
		this._scrollingUp = false
		this.triggerStartSpeedScrolling()
	}
	public stopManualScrolling() {
		if ( (!this._scrollingDown) && (!this._scrollingUp) ) {
			this._scrollSpeedTarget = 0
		}
		this._nudgeLowPass.reset()
	}

	public nudge (delta: number) {
		let delta2: number = delta * this.nudgeMultiplier
		delta2 = this._nudgeLowPass.feed(delta2)
		if (this._updateSpeedHandle !== null) {
			this._toNudge += delta2
		} else {
			window.scrollBy(0, delta2);
		}
	}
	public continueScrolling() {
		if ( (!this._scrollingDown) && (!this._scrollingUp) ) {
			this._scrollingManual = true
			this._scrollSpeedTarget = this._nudgeLowPass.last
			this._startScrolling()
		}
		this._nudgeLowPass.reset()
	}

	public changeScrollingSpeed(delta: number) {
		let delta2: number = delta * Math.max(1, this._autoScrollSpeed) * 0.1
		this._autoScrollSpeed = Math.max(0.3, this._autoScrollSpeed + delta2) // allow only positive
		if (this._scrollingDown || this._scrollingUp) {
			this._scrollSpeedTarget = this._autoScrollSpeed
		}
		this.triggerStartSpeedScrolling()
	}

	private triggerStartSpeedScrolling() {
		if (this._scrollingDown) {
			const scrollPosition = window.scrollY
			if (scrollPosition !== undefined) {
				this._nextPausePosition = this._prompterView.findAnchorPosition(scrollPosition + 50, -1, 1)
			}
		} else {
			this._nextPausePosition = null
		}
		this._scrollingManual = false
		this._scrollSpeedTarget = this._autoScrollSpeed
		this._startScrolling()
	}
	private _startScrolling() {
		this._noMovement = 0
		this._updateScrollPosition()
	}
	private _updateScrollPosition() {
		if (this._destroyed) return
		if (this._updateSpeedHandle !== null) return
		this._updateSpeedHandle = null

		let scrollPosition = window.scrollY

		if (
			scrollPosition !== undefined &&
			this._nextPausePosition &&
			this._scrollingDown &&
			scrollPosition > this._nextPausePosition - 5 * this._scrollSpeedCurrent
		) {
			// stop
			this._scrollingDown = false
		}

		if (this._scrollingManual) {
			this._scrollSpeedTarget *= this.manualScrollingInertia
		}
		let targetSpeed = this._scrollSpeedTarget

		if (this._scrollingUp) {
			targetSpeed = -Math.sign(targetSpeed) * Math.max(10, Math.abs(targetSpeed) * 4)
		} else if (this._scrollingDown || this._scrollingManual) {
			targetSpeed = targetSpeed * 1
		} else {
			targetSpeed = 0
		}

		let ds: number = (targetSpeed - this._scrollSpeedCurrent)
		if (Math.abs(this._scrollSpeedCurrent) < Math.abs(targetSpeed)) {
			// Do it quicker when accelerating, to increate perceived latency:
			ds *= 0.2
		} else {
			ds *= 0.1
		}

		if (Math.abs(ds) > 0.1) {
			this._scrollSpeedCurrent += ds
		} else {
			this._scrollSpeedCurrent = targetSpeed
		}

		let speed = Math.round(this._scrollSpeedCurrent) // round because the scrolling is only done in full pixels anyway
		if (speed < 4) {
			// save the rest, in order to scroll veeery slowly (sub-pixels)
			this._scrollRest += Math.round((this._scrollSpeedCurrent - speed) * 6) / 6 // put the rest to use later
			const speedFromRest = Math.round(this._scrollRest)
			if (speedFromRest !== 0) {
				speed += speedFromRest
				this._scrollRest -= speedFromRest
			}
		} else {
			this._scrollRest = 0
		}

		window.scrollBy(0, speed + this._toNudge)
		this._toNudge = 0

		scrollPosition = window.scrollY

		if (scrollPosition !== undefined) {
			// Reached end-of-scroll:
			if (
				(
					scrollPosition < 10 && // positioned at the top
					speed < -10 // only check if we have a significant speed
				) && (
					scrollPosition >= 10 && // positioned not at the top
					speed > 10 // only check if we have a significant speed
				) &&
				this._scrollPosition === scrollPosition
			) {
				// We tried to move, but haven't
				// Reset speeds:

				if (!this._scrollingUp) { // don't check if we're scrolling up
					this._scrollSpeedCurrent = 0
					this._scrollSpeedTarget = 0
				}
				this._scrollDownDelta = 0
				this._scrollDownDeltaTracker = 0
			}
			this._scrollPosition = scrollPosition
		}
		if (speed === 0) {
			this._noMovement++
		} else {
			this._noMovement = 0
		}
		if (this._noMovement < 5) {
			this._updateSpeedHandle = window.requestAnimationFrame(() => {
				this._updateSpeedHandle = null
				this._updateScrollPosition()
			})
		} else {
			this._scrollingDown = false
			this._scrollingUp = false
			this._scrollingManual = false
		}
	}

}
