import { Mongo } from 'meteor/mongo'
import { Timeline } from 'timeline-state-resolver-types'
import { TransformedCollection } from '../typings/meteor'
import { registerCollection, literal } from '../lib'
import { Meteor } from 'meteor/meteor'
import { Piece, PieceBase } from './Pieces'

export interface PieceInstance extends PieceBase {
	_id: string
	partInstanceId: string
	pieceId: string

	/** A flag to signal a given Piece has been deactivated manually */
	disabled?: boolean // TODO - here or Piece?

	/** This is set when an piece's duration needs to be overriden */
	userDuration?: Pick<Timeline.TimelineEnable, 'duration' | 'end'>

	/** If this piece has been created play-time using an AdLibPiece, this should be set to it's source piece */
	adLibSourceId?: string

	/** If this piece has been insterted during run of rundown (such as adLibs). Df set, this won't be affected by updates from MOS */
	// dynamicallyInserted?: boolean, // TODO Is this needed?

	/** The time the system started playback of this part, null if not yet played back (milliseconds since epoch) */
	startedPlayback?: number

	/** Whether the piece has stopped playback (the most recent time it was played).
	 * This is set from a callback from the playout gateway
	 */
	stoppedPlayback?: number

	/** Actual duration of the piece, as played-back, in milliseconds. This value will be updated during playback for some types of pieces. */
	playoutDuration?: number
}

export function PieceInstanceFromPiece (piece: Piece, partInstanceId: string) {
	return literal<PieceInstance>({
		...piece,
		pieceId: piece._id,
		partInstanceId: partInstanceId,
		_id: ''
	})
}

export const PieceInstances: TransformedCollection<PieceInstance, PieceInstance>
	= new Mongo.Collection<PieceInstance>('pieceInstances')
registerCollection('PieceInstances', PieceInstances)
Meteor.startup(() => {
	if (Meteor.isServer) {
		PieceInstances._ensureIndex({
			rundownId: 1,
			partInstanceId: 1
		})
	}
})
