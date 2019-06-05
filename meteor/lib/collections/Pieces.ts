import { Mongo } from 'meteor/mongo'
import { RundownAPI } from '../api/rundown'
import { TransformedCollection } from '../typings/meteor'
import { registerCollection, Omit } from '../lib'
import { Meteor } from 'meteor/meteor'
import {
	IBlueprintPieceGeneric,
	IBlueprintPiece,
	PieceLifespan,
	BaseContent,
} from 'tv-automation-sofie-blueprints-integration'

/** A Single item in a "line": script, VT, cameras */
export interface PieceGeneric extends IBlueprintPieceGeneric {
	/** ID of the source object in MOS */
	externalId: string
	/** The rundown this piece belongs to */
	rundownId: string

	/** Playback availability status */
	status: RundownAPI.PieceStatusCode
	/** A flag to signal a given Piece has been deactivated manually */
	// disabled?: boolean // TODO - here or Instance?
	/** A flag to signal that a given Piece should be hidden from the UI */
	hidden?: boolean
	/** A flag to signal that a given Piece has no content, and exists only as a marker on the timeline */
	virtual?: boolean

	/** The id of the piece this piece is a continuation of. If it is a continuation, the inTranstion must not be set, and enable.start must be 0 */
	continuesRefId?: string
	/** Playout timings, in here we log times when playout happens */
	// timings?: PartTimings

	isTransition?: boolean
	extendOnHold?: boolean
}

export interface PieceBase extends PieceGeneric, Omit<IBlueprintPiece, '_id'> {
	partId: string

	/** This is set when the piece is infinite, to deduplicate the contents on the timeline, while allowing out of order */
	infiniteMode?: PieceLifespan
	/** This is the id of the original segment of an infinite piece chain. If it matches the id of itself then it is the first in the chain */
	infiniteId?: string

	/** The object describing the piece in detail */
	content?: BaseContent // TODO: Temporary, should be put into IBlueprintPiece

	/** This is set when the piece isn't infinite, but should overflow it's duration onto the adjacent (not just next) part on take */
	overflows?: boolean
}

export interface Piece extends PieceBase {
	_id: string
}

export const Pieces: TransformedCollection<Piece, Piece>
	= new Mongo.Collection<Piece>('pieces')
registerCollection('Pieces', Pieces)
Meteor.startup(() => {
	if (Meteor.isServer) {
		Pieces._ensureIndex({
			rundownId: 1,
			partId: 1
		})
	}
})
