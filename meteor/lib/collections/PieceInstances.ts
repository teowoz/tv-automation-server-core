import { TransformedCollection } from '../typings/meteor'
import { registerCollection, literal } from '../lib'
import { Meteor } from 'meteor/meteor'
import { IBlueprintPieceInstance, Time } from 'tv-automation-sofie-blueprints-integration'
import { createMongoCollection } from './lib'
import { Piece } from './Pieces'

// TODO - ensure all of these are needed/used
export interface TmpPieceInstanceTimings {
	/** Point in time the Part was taken, (ie the time of the user action) */
	take?: Time
	/** Point in time the "take" action has finished executing */
	takeDone?: Time
	/** Point in time the Part started playing (ie the time of the playout) */
	startedPlayback?: Time
	/** Point in time the Part stopped playing (ie the time of the user action) */
	takeOut?: Time
	/** Point in time the Part stopped playing (ie the time of the playout) */
	stoppedPlayback?: Time
	/** Point in time the Part was set as Next (ie the time of the user action) */
	next?: Time

	/** The playback offset that was set for the last take */
	playOffset?: Time
}

/** A Single item in a "line": script, VT, cameras */
export interface PieceInstance extends IBlueprintPieceInstance {
	// ------------------------------------------------------------------
	_id: string
	/** The rundown this piece belongs to */
	rundownId: string
	/** The part instace this piece belongs to */
	partInstanceId: string

	piece: Piece

	/** A flag to signal a given Piece has been deactivated manually */
	disabled?: boolean

	/** If this piece has been created play-time using an AdLibPiece, this should be set to it's source piece */
	adLibSourceId?: string
	/** If this piece has been insterted during run of rundown (such as adLibs). Df set, this won't be affected by updates from MOS */
	dynamicallyInserted?: boolean,
	/** The id of the piece this piece is a continuation of. If it is a continuation, the inTranstion must not be set, and enable.start must be 0 */
	continuesRefId?: string
	/** The time the system started playback of this part, null if not yet played back (milliseconds since epoch) */
	// startedPlayback?: number
	/** Actual duration of the piece, as played-back, in milliseconds. This value will be updated during playback for some types of pieces. */
	playoutDuration?: number
	/** Whether the piece has stopped playback (the most recent time it was played).
	 * This is set from a callback from the playout gateway
	 */
	stoppedPlayback?: number

	/** Playout timings, in here we log times when playout happens */
	timings: TmpPieceInstanceTimings
}

export function WrapPieceToTemporaryInstance (piece: Piece, partInstanceId: string): PieceInstance {
	return literal<PieceInstance>({
		_id: `${piece._id}_tmp_instance`,
		rundownId: piece.rundownId,
		partInstanceId: partInstanceId,
		piece: piece,
		timings: {}
	})
}

export function FindPieceInstanceOrWrapToTemporary (partInstances: PieceInstance[], partInstanceId: string, piece: Piece): PieceInstance {
	return partInstances.find(instance => instance.piece._id === piece._id) || WrapPieceToTemporaryInstance(piece, partInstanceId)
}

export const PieceInstances: TransformedCollection<PieceInstance, PieceInstance> = createMongoCollection<PieceInstance>('pieceInstances')
registerCollection('PieceInstances', PieceInstances)
Meteor.startup(() => {
	if (Meteor.isServer) {
		PieceInstances._ensureIndex({
			rundownId: 1,
			partInstanceId: 1
		})
	}
})
