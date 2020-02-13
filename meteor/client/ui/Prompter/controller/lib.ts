import * as _ from 'underscore'
import { PrompterViewInner } from '../PrompterView'

export const LONGPRESS_TIME = 500

export abstract class ControllerAbstract {

	private _view: PrompterViewInner
	constructor (view: PrompterViewInner) {
		this._view = view

	}
	public abstract destroy (): void
	public abstract onKeyDown (e: KeyboardEvent): void
	public abstract onKeyUp (e: KeyboardEvent): void
	public abstract onMouseKeyDown (e: MouseEvent): void
	public abstract onMouseKeyUp (e: MouseEvent): void
	public abstract onWheel (e: WheelEvent): void
}

export interface PrompterControlInterface {
	startScrollingDown(): void
	startScrollingUp(): void
	stopScrolling(): void
	stopScrollingDown(): void
	stopScrollingUp(): void
	nudge(delta: number): void
	changeScrollingSpeed(delta: number): void
}