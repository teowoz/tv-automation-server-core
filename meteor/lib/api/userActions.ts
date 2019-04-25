export namespace UserActionAPI {
	/**
	 * These methods are intended to be called by a user,
	 * and the server response will be of the type ClientAPI.ClientResponse
	 */
	export enum methods {
		'take' 									= 'userAction.take',
		'setNext' 								= 'userAction.setNext',
		'moveNext' 								= 'userAction.moveNext',

		'prepareForBroadcast' 					= 'userAction.prepareForBroadcast',
		'resetRundown' 					= 'userAction.resetRundown',
		'resetAndActivate' 						= 'userAction.resetAndActivate',
		'activate' 								= 'userAction.activate',
		'deactivate' 							= 'userAction.deactivate',
		'reloadData' 							= 'userAction.reloadData',

		'disableNextPiece'			= 'userAction.disableNextPiece',
		'togglePartArgument'				= 'userAction.togglePartArgument',
		'pieceTakeNow'				= 'userAction.pieceTakeNow',
		'setInOutPoints'						= 'userAction.pieceSetInOutPoints',

		'segmentAdLibLineItemStart'				= 'userAction.segmentAdLibLineItemStart',
		'sourceLayerOnLineStop'					= 'userAction.sourceLayerOnLineStop',
		'baselineAdLibItemStart'				= 'userAction.baselineAdLibItemStart',
		'segmentAdLibLineItemStop'				= 'userAction.segmentAdLibLineItemStop',

		'sourceLayerStickyItemStart'			= 'userAction.sourceLayerStickyItemStart',

		'activateHold'							= 'userAction.activateHold',

		'saveEvaluation' 						= 'userAction.saveEvaluation',

		// 'rundownStoriesMoved'						= 'userAction.rundownStoriesMoved',
		// 'partPlaybackStartedCallback'	= 'userAction.partPlaybackStartedCallback',
		// 'piecePlaybackStartedCallback'= 'userAction.piecePlaybackStartedCallback',

		'storeRundownSnapshot'				= 'userAction.storeRundownSnapshot',

		'removeRundown'					= 'userAction.removeRundown',
		'resyncRundown'					= 'userAction.resyncRundown',

		'recordStop'							= 'userAction.recordStop',
		'recordStart'							= 'userAction.recordStart',
		'recordDelete'							= 'userAction.recordDelete',

		'mediaRestartWorkflow'					= 'userAction.mediamanager.restartWorkflow',
		'mediaAbortWorkflow'					= 'userAction.mediamanager.abortWorkflow'
	}
}
