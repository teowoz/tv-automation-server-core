import { Meteor } from 'meteor/meteor'
import { literal } from '../../../../lib/lib'
import { PlayoutRundownData, Rundown } from '../../../../lib/collections/Rundowns'
import { findLookaheadForlayer } from '../lookahead'
import { LookaheadMode } from 'tv-automation-sofie-blueprints-integration'
import { Segment } from '../../../../lib/collections/Segments'
import { Part } from '../../../../lib/collections/Parts'
import { Piece } from '../../../../lib/collections/Pieces'
import { testInFiber } from '../../../../__mocks__/helpers/jest'

function getSampleRundownData () {
	const res = literal<PlayoutRundownData>({
		rundown: new Rundown({
			_id: 'mock',
			externalId: 'mock',
			studioId: '',
			showStyleBaseId: '',
			showStyleVariantId: '',
			peripheralDeviceId: '',
			name: 'Mock rundown',
			created: 0,
			modified: 0,
			importVersions: {
				studio: '',
				blueprint: '',
				showStyleBase: '',
				showStyleVariant: '',
				core: ''
			},
			previousPartId: null,
			nextPartId: null,
			currentPartId: null,
			dataSource: '',
		}),
		segments: [],
		segmentsMap: {},
		parts: [],
		partsMap: {},
		pieces: []
	})

	// Create some segments
	res.segments.push(res.segmentsMap['seg1'] = new Segment({
		_id: 'seg1',
		_rank: 1,
		externalId: 'seg1',
		rundownId: 'mock',
		name: 'seg 1'
	}))
	res.segments.push(res.segmentsMap['seg2'] = new Segment({
		_id: 'seg2',
		_rank: 2,
		externalId: 'seg2',
		rundownId: 'mock',
		name: 'seg 2'
	}))
	res.segments.push(res.segmentsMap['seg3'] = new Segment({
		_id: 'seg3',
		_rank: 3,
		externalId: 'seg3',
		rundownId: 'mock',
		name: 'seg 3'
	}))

	// Create some parts
	res.parts.push(res.partsMap['part1'] = new Part({
		_id: 'part1',
		_rank: 1,
		rundownId: 'mock',
		segmentId: 'seg1',
		externalId: 'part1',
		title: 'Part 1',
		typeVariant: ''
	}))
	res.parts.push(res.partsMap['part2'] = new Part({
		_id: 'part2',
		_rank: 2,
		rundownId: 'mock',
		segmentId: 'seg1',
		externalId: 'part2',
		title: 'Part 2',
		typeVariant: ''
	}))
	res.parts.push(res.partsMap['part3'] = new Part({
		_id: 'part3',
		_rank: 3,
		rundownId: 'mock',
		segmentId: 'seg2',
		externalId: 'part3',
		title: 'Part 3',
		typeVariant: ''
	}))
	res.parts.push(res.partsMap['part4'] = new Part({
		_id: 'part4',
		_rank: 4,
		rundownId: 'mock',
		segmentId: 'seg3',
		externalId: 'part4',
		title: 'Part 4',
		typeVariant: ''
	}))
	res.parts.push(res.partsMap['part5'] = new Part({
		_id: 'part5',
		_rank: 5,
		rundownId: 'mock',
		segmentId: 'seg3',
		externalId: 'part5',
		title: 'Part 5',
		typeVariant: ''
	}))

	// Create some pieces
	res.pieces.push(literal<Piece>({
		_id: 'part1_1',
		partId: 'part1',
		rundownId: 'mock',
		externalId: 'part1_1',
		status: -1,
		name: 'Part 1 - Piece 1',
		sourceLayerId: 'layer1',
		outputLayerId: 'pgm',
		enable: {
			start: 0
		}
		// TODO - finish this piece and add many more..
	}))

	return res
}


describe('playout', () => {
	describe('lookahead', () => {
		describe('findLookaheadForlayer', () => {
			testInFiber('no active parts', () => {
				const rundownData = getSampleRundownData()

				const res = findLookaheadForlayer(rundownData, 'layer1', LookaheadMode.NONE, 1)
				expect(res).toBeTruthy()
				expect(res.future).toHaveLength(0)
				expect(res.timed).toHaveLength(0)
			})
		})
	})
})