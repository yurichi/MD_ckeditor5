/**
 * @license Copyright (c) 2003-2022, CKSource Holding sp. z o.o. All rights reserved.
 * For licensing, see LICENSE.md or https://ckeditor.com/legal/ckeditor-oss-license
 */

/**
 * @module utils/emittermixin
 */

import EventInfo from './eventinfo';
import uid from './uid';
import priorities, { type PriorityString } from './priorities';
import insertToPriorityArray from './inserttopriorityarray';

// To check if component is loaded more than once.
import './version';
import CKEditorError from './ckeditorerror';

const _listeningTo = Symbol( 'listeningTo' );
const _emitterId = Symbol( 'emitterId' );
const _delegations = Symbol( 'delegations' );

/**
 * Mixin that injects the {@link ~Emitter events API} into its host.
 *
 * Read more about the concept of emitters in the:
 * * {@glink framework/guides/architecture/core-editor-architecture#event-system-and-observables Event system and observables}
 * section of the {@glink framework/guides/architecture/core-editor-architecture Core editor architecture} guide.
 * * {@glink framework/guides/deep-dive/event-system Event system} deep dive guide.
 *
 * @mixin EmitterMixin
 * @implements module:utils/emittermixin~Emitter
 */
const EmitterMixin: Emitter = {
	/**
	 * @inheritDoc
	 */
	on( event, callback, options = {} ) {
		this.listenTo( this, event, callback, options );
	},

	/**
	 * @inheritDoc
	 */
	once( event, callback, options ) {
		let wasFired = false;

		const onceCallback: typeof callback = ( event, ...args ) => {
			// Ensure the callback is called only once even if the callback itself leads to re-firing the event
			// (which would call the callback again).
			if ( !wasFired ) {
				wasFired = true;

				// Go off() at the first call.
				event.off();

				// Go with the original callback.
				callback.call( this, event, ...args );
			}
		};

		// Make a similar on() call, simply replacing the callback.
		this.listenTo( this, event, onceCallback, options );
	},

	/**
	 * @inheritDoc
	 */
	off( event, callback ) {
		this.stopListening( this, event, callback );
	},

	/**
	 * @inheritDoc
	 */
	listenTo( emitter, event, callback, options = {} ) {
		let emitterInfo, eventCallbacks;

		// _listeningTo contains a list of emitters that this object is listening to.
		// This list has the following format:
		//
		// _listeningTo: {
		//     emitterId: {
		//         emitter: emitter,
		//         callbacks: {
		//             event1: [ callback1, callback2, ... ]
		//             ....
		//         }
		//     },
		//     ...
		// }

		if ( !this[ _listeningTo ] ) {
			this[ _listeningTo ] = {};
		}

		const emitters = this[ _listeningTo ]!;

		if ( !_getEmitterId( emitter ) ) {
			_setEmitterId( emitter );
		}

		const emitterId = _getEmitterId( emitter )!;

		if ( !( emitterInfo = emitters[ emitterId ] ) ) {
			emitterInfo = emitters[ emitterId ] = {
				emitter,
				callbacks: {}
			};
		}

		if ( !( eventCallbacks = emitterInfo.callbacks[ event ] ) ) {
			eventCallbacks = emitterInfo.callbacks[ event ] = [];
		}

		eventCallbacks.push( callback );

		// Finally register the callback to the event.
		addEventListener( this, emitter, event, callback, options );
	},

	/**
	 * @inheritDoc
	 */
	stopListening( emitter?: Emitter, event?: string, callback?: Function ) {
		const emitters = this[ _listeningTo ];
		let emitterId = emitter && _getEmitterId( emitter );
		const emitterInfo = ( emitters && emitterId ) ? emitters[ emitterId ] : undefined;
		const eventCallbacks = ( emitterInfo && event ) ? emitterInfo.callbacks[ event ] : undefined;

		// Stop if nothing has been listened.
		if ( !emitters || ( emitter && !emitterInfo ) || ( event && !eventCallbacks ) ) {
			return;
		}

		// All params provided. off() that single callback.
		if ( callback ) {
			removeEventListener( this, emitter!, event!, callback );

			// We must remove callbacks as well in order to prevent memory leaks.
			// See https://github.com/ckeditor/ckeditor5/pull/8480
			const index = eventCallbacks!.indexOf( callback );

			if ( index !== -1 ) {
				if ( eventCallbacks!.length === 1 ) {
					delete emitterInfo!.callbacks[ event! ];
				} else {
					removeEventListener( this, emitter!, event!, callback );
				}
			}
		}
		// Only `emitter` and `event` provided. off() all callbacks for that event.
		else if ( eventCallbacks ) {
			while ( ( callback = eventCallbacks.pop() ) ) {
				removeEventListener( this, emitter!, event!, callback );
			}

			delete emitterInfo!.callbacks[ event! ];
		}
		// Only `emitter` provided. off() all events for that emitter.
		else if ( emitterInfo ) {
			for ( event in emitterInfo.callbacks ) {
				this.stopListening( emitter!, event );
			}
			delete emitters[ emitterId! ];
		}
		// No params provided. off() all emitters.
		else {
			for ( emitterId in emitters ) {
				this.stopListening( emitters[ emitterId ].emitter );
			}
			delete this[ _listeningTo ];
		}
	},

	/**
	 * @inheritDoc
	 */
	fire( eventOrInfo, ...args ) {
		try {
			const eventInfo = eventOrInfo instanceof EventInfo ? eventOrInfo : new EventInfo( this, eventOrInfo );
			const event = eventInfo.name;
			let callbacks = getCallbacksForEvent( this, event );

			// Record that the event passed this emitter on its path.
			eventInfo.path.push( this );

			// Handle event listener callbacks first.
			if ( callbacks ) {
				// Arguments passed to each callback.
				const callbackArgs = [ eventInfo, ...args ];

				// Copying callbacks array is the easiest and most secure way of preventing infinite loops, when event callbacks
				// are added while processing other callbacks. Previous solution involved adding counters (unique ids) but
				// failed if callbacks were added to the queue before currently processed callback.
				// If this proves to be too inefficient, another method is to change `.on()` so callbacks are stored if same
				// event is currently processed. Then, `.fire()` at the end, would have to add all stored events.
				callbacks = Array.from( callbacks );

				for ( let i = 0; i < callbacks.length; i++ ) {
					callbacks[ i ].callback.apply( this, callbackArgs );

					// Remove the callback from future requests if off() has been called.
					if ( eventInfo.off.called ) {
						// Remove the called mark for the next calls.
						delete eventInfo.off.called;

						this._removeEventListener( event, callbacks[ i ].callback );
					}

					// Do not execute next callbacks if stop() was called.
					if ( eventInfo.stop.called ) {
						break;
					}
				}
			}

			// Delegate event to other emitters if needed.
			const delegations = this[ _delegations ];

			if ( delegations ) {
				const destinations = delegations.get( event );
				const passAllDestinations = delegations.get( '*' );

				if ( destinations ) {
					fireDelegatedEvents( destinations, eventInfo, args );
				}

				if ( passAllDestinations ) {
					fireDelegatedEvents( passAllDestinations, eventInfo, args );
				}
			}

			return eventInfo.return;
		} catch ( err ) {
			// @if CK_DEBUG // throw err;
			/* istanbul ignore next */
			CKEditorError.rethrowUnexpectedError( err as Error, this );
		}
	},

	/**
	 * @inheritDoc
	 */
	delegate( ...events ) {
		return {
			to: ( emitter, nameOrFunction ) => {
				if ( !this[ _delegations ] ) {
					this[ _delegations ] = new Map();
				}

				// Originally there was a for..of loop which unfortunately caused an error in Babel that didn't allow
				// build an application. See: https://github.com/ckeditor/ckeditor5-react/issues/40.
				events.forEach( eventName => {
					const destinations = this[ _delegations ]!.get( eventName );

					if ( !destinations ) {
						this[ _delegations ]!.set( eventName, new Map( [ [ emitter, nameOrFunction ] ] ) );
					} else {
						destinations.set( emitter, nameOrFunction );
					}
				} );
			}
		};
	},

	/**
	 * @inheritDoc
	 */
	stopDelegating( event?: string, emitter?: Emitter ) {
		if ( !this[ _delegations ] ) {
			return;
		}

		if ( !event ) {
			this[ _delegations ]!.clear();
		} else if ( !emitter ) {
			this[ _delegations ]!.delete( event );
		} else {
			const destinations = this[ _delegations ]!.get( event );

			if ( destinations ) {
				destinations.delete( emitter );
			}
		}
	},

	/**
	 * @inheritDoc
	 */
	_addEventListener( event, callback, options ) {
		createEventNamespace( this, event );

		const lists = getCallbacksListsForNamespace( this, event );
		const priority = priorities.get( options.priority );

		const callbackDefinition = {
			callback,
			priority
		};

		// Add the callback to all callbacks list.
		for ( const callbacks of lists ) {
			// Add the callback to the list in the right priority position.
			insertToPriorityArray( callbacks, callbackDefinition );
		}
	},

	/**
	 * @inheritDoc
	 */
	_removeEventListener( event, callback ) {
		const lists = getCallbacksListsForNamespace( this, event );

		for ( const callbacks of lists ) {
			for ( let i = 0; i < callbacks.length; i++ ) {
				if ( callbacks[ i ].callback == callback ) {
					// Remove the callback from the list (fixing the next index).
					callbacks.splice( i, 1 );
					i--;
				}
			}
		}
	}
};

export default EmitterMixin;

/**
 * Emitter/listener interface.
 *
 * Can be easily implemented by a class by mixing the {@link module:utils/emittermixin~EmitterMixin} mixin.
 *
 * Read more about the usage of this interface in the:
 * * {@glink framework/guides/architecture/core-editor-architecture#event-system-and-observables Event system and observables}
 * section of the {@glink framework/guides/architecture/core-editor-architecture Core editor architecture} guide.
 * * {@glink framework/guides/deep-dive/event-system Event system} deep dive guide.
 *
 * @interface
 */
export interface Emitter {

	/**
	 * Registers a callback function to be executed when an event is fired.
	 *
	 * Shorthand for {@link #listenTo `this.listenTo( this, event, callback, options )`} (it makes the emitter
	 * listen on itself).
	 *
	 * @method
	 * @param {String} event The name of the event.
	 * @param {Function} callback The function to be called on event.
	 * @param {module:utils/emittermixin~CallbackOptions} [options={}] Additional options.
	 * @param {module:utils/priorities~PriorityString|Number} [options.priority='normal'] The priority of this event callback. The higher
	 * the priority value the sooner the callback will be fired. Events having the same priority are called in the
	 * order they were added.
	 */
	on<TEvent extends BaseEvent>(
		event: TEvent[ 'name' ],
		callback: GetCallback<TEvent>,
		options?: CallbackOptions
	): void;

	/**
	 * Registers a callback function to be executed on the next time the event is fired only. This is similar to
	 * calling {@link #on} followed by {@link #off} in the callback.
	 *
	 * @method
	 * @param {String} event The name of the event.
	 * @param {Function} callback The function to be called on event.
	 * @param {module:utils/emittermixin~CallbackOptions} [options={}] Additional options.
	 * @param {module:utils/priorities~PriorityString|Number} [options.priority='normal'] The priority of this event callback. The higher
	 * the priority value the sooner the callback will be fired. Events having the same priority are called in the
	 * order they were added.
	 */
	once<TEvent extends BaseEvent>(
		event: TEvent[ 'name' ],
		callback: GetCallback<TEvent>,
		options?: CallbackOptions
	): void;

	/**
	 * Stops executing the callback on the given event.
	 * Shorthand for {@link #stopListening `this.stopListening( this, event, callback )`}.
	 *
	 * @method
	 * @param {String} event The name of the event.
	 * @param {Function} callback The function to stop being called.
	 */
	off( event: string, callback: Function ): void;

	/**
	 * Registers a callback function to be executed when an event is fired in a specific (emitter) object.
	 *
	 * Events can be grouped in namespaces using `:`.
	 * When namespaced event is fired, it additionally fires all callbacks for that namespace.
	 *
	 *		// myEmitter.on( ... ) is a shorthand for myEmitter.listenTo( myEmitter, ... ).
	 *		myEmitter.on( 'myGroup', genericCallback );
	 *		myEmitter.on( 'myGroup:myEvent', specificCallback );
	 *
	 *		// genericCallback is fired.
	 *		myEmitter.fire( 'myGroup' );
	 *		// both genericCallback and specificCallback are fired.
	 *		myEmitter.fire( 'myGroup:myEvent' );
	 *		// genericCallback is fired even though there are no callbacks for "foo".
	 *		myEmitter.fire( 'myGroup:foo' );
	 *
	 * An event callback can {@link module:utils/eventinfo~EventInfo#stop stop the event} and
	 * set the {@link module:utils/eventinfo~EventInfo#return return value} of the {@link #fire} method.
	 *
	 * @method
	 * @param {module:utils/emittermixin~Emitter} emitter The object that fires the event.
	 * @param {String} event The name of the event.
	 * @param {Function} callback The function to be called on event.
	 * @param {module:utils/emittermixin~CallbackOptions} [options={}] Additional options.
	 * @param {module:utils/priorities~PriorityString|Number} [options.priority='normal'] The priority of this event callback. The higher
	 * the priority value the sooner the callback will be fired. Events having the same priority are called in the
	 * order they were added.
	 */
	listenTo<TEvent extends BaseEvent>(
		emitter: Emitter,
		event: TEvent[ 'name' ],
		callback: GetCallback<TEvent>,
		options?: CallbackOptions
	): void;

	/**
	 * Stops listening for events. It can be used at different levels:
	 *
	 * * To stop listening to a specific callback.
	 * * To stop listening to a specific event.
	 * * To stop listening to all events fired by a specific object.
	 * * To stop listening to all events fired by all objects.
	 *
	 * @method
	 * @param {module:utils/emittermixin~Emitter} [emitter] The object to stop listening to. If omitted, stops it for all objects.
	 * @param {String} [event] (Requires the `emitter`) The name of the event to stop listening to. If omitted, stops it
	 * for all events from `emitter`.
	 * @param {Function} [callback] (Requires the `event`) The function to be removed from the call list for the given
	 * `event`.
	 */
	stopListening( emitter?: Emitter, event?: string, callback?: Function ): void;

	/**
	 * Fires an event, executing all callbacks registered for it.
	 *
	 * The first parameter passed to callbacks is an {@link module:utils/eventinfo~EventInfo} object,
	 * followed by the optional `args` provided in the `fire()` method call.
	 *
	 * @method
	 * @param {String|module:utils/eventinfo~EventInfo} eventOrInfo The name of the event or `EventInfo` object if event is delegated.
	 * @param {...*} [args] Additional arguments to be passed to the callbacks.
	 * @returns {*} By default the method returns `undefined`. However, the return value can be changed by listeners
	 * through modification of the {@link module:utils/eventinfo~EventInfo#return `evt.return`}'s property (the event info
	 * is the first param of every callback).
	 */
	fire<TEvent extends BaseEvent>(
		eventOrInfo: GetNameOrEventInfo<TEvent>,
		...args: TEvent[ 'args' ]
	): GetEventInfo<TEvent>[ 'return' ];

	/**
	 * Delegates selected events to another {@link module:utils/emittermixin~Emitter}. For instance:
	 *
	 *		emitterA.delegate( 'eventX' ).to( emitterB );
	 *		emitterA.delegate( 'eventX', 'eventY' ).to( emitterC );
	 *
	 * then `eventX` is delegated (fired by) `emitterB` and `emitterC` along with `data`:
	 *
	 *		emitterA.fire( 'eventX', data );
	 *
	 * and `eventY` is delegated (fired by) `emitterC` along with `data`:
	 *
	 *		emitterA.fire( 'eventY', data );
	 *
	 * @method
	 * @param {...String} events Event names that will be delegated to another emitter.
	 * @returns {module:utils/emittermixin~EmitterMixinDelegateChain}
	 */
	delegate( ...events: string[] ): EmitterMixinDelegateChain;

	/**
	 * Stops delegating events. It can be used at different levels:
	 *
	 * * To stop delegating all events.
	 * * To stop delegating a specific event to all emitters.
	 * * To stop delegating a specific event to a specific emitter.
	 *
	 * @method
	 * @param {String} [event] The name of the event to stop delegating. If omitted, stops it all delegations.
	 * @param {module:utils/emittermixin~Emitter} [emitter] (requires `event`) The object to stop delegating a particular event to.
	 * If omitted, stops delegation of `event` to all emitters.
	 */
	stopDelegating( event?: string, emitter?: Emitter ): void;

	/**
	 * Adds callback to emitter for given event.
	 *
	 * @internal
	 * @protected
	 * @method #_addEventListener
	 * @param {String} event The name of the event.
	 * @param {Function} callback The function to be called on event.
	 * @param {module:utils/emittermixin~CallbackOptions} options={} Additional options.
	 * @param {module:utils/priorities~PriorityString|Number} [options.priority='normal'] The priority of this event callback. The higher
	 * the priority value the sooner the callback will be fired. Events having the same priority are called in the
	 * order they were added.
	 */
	_addEventListener<TEvent extends BaseEvent>(
		event: TEvent[ 'name' ],
		callback: GetCallback<TEvent>,
		options: CallbackOptions
	): void;

	/**
	 * Removes callback from emitter for given event.
	 *
	 * @internal
	 * @protected
	 * @method #_removeEventListener
	 * @param {String} event The name of the event.
	 * @param {Function} callback The function to stop being called.
	 */
	_removeEventListener( event: string, callback: Function ): void;

	/** @internal */
	_events?: { [ eventName: string ]: EventNode };

	/** @internal */
	[ _emitterId ]?: string;

	/** @internal */
	[ _listeningTo ]?: {
		[ emitterId: string ]: {
			emitter: Emitter;
			callbacks: { [ event: string]: Function[] };
		};
	};

	/** @internal */
	[ _delegations ]?: Map<string, Map<Emitter, string | ( ( name: string ) => string ) | undefined>>;
}

export type BaseEvent = {
	name: string;
	args: any[];
};

export type GetEventInfo<TEvent extends BaseEvent> = TEvent extends { eventInfo: EventInfo } ?
	TEvent[ 'eventInfo' ] :
	EventInfo<TEvent[ 'name' ], ( TEvent extends { return: infer TReturn } ? TReturn : unknown )>;

export type GetNameOrEventInfo<TEvent extends BaseEvent> = TEvent extends { eventInfo: EventInfo } ?
	TEvent[ 'eventInfo' ] :
	TEvent[ 'name' ] | EventInfo<TEvent[ 'name' ], ( TEvent extends { return: infer TReturn } ? TReturn : unknown )>;

export type GetCallback<TEvent extends BaseEvent> = ( this: Emitter, ev: GetEventInfo<TEvent>, ...args: TEvent[ 'args' ] ) => void;

/**
 * Additional options for registering a callback.
 *
 * @typedef {Object} module:utils/emittermixin~CallbackOptions
 * @property {module:utils/priorities~PriorityString|Number} [priority] The priority of this event callback. The higher
 * the priority value the sooner the callback will be fired. Events having the same priority are called in the
 * order they were added.
 */
export interface CallbackOptions {
	readonly priority?: PriorityString | number;
}

/**
 * Checks if `listeningEmitter` listens to an emitter with given `listenedToEmitterId` and if so, returns that emitter.
 * If not, returns `null`.
 *
 * @internal
 * @protected
 * @param {module:utils/emittermixin~Emitter} listeningEmitter An emitter that listens.
 * @param {String} listenedToEmitterId Unique emitter id of emitter listened to.
 * @returns {module:utils/emittermixin~Emitter|null}
 */
export function _getEmitterListenedTo( listeningEmitter: Emitter, listenedToEmitterId: string ): Emitter | null {
	const listeningTo = listeningEmitter[ _listeningTo ];
	if ( listeningTo && listeningTo[ listenedToEmitterId ] ) {
		return listeningTo[ listenedToEmitterId ].emitter;
	}

	return null;
}

/**
 * Sets emitter's unique id.
 *
 * **Note:** `_emitterId` can be set only once.
 *
 * @internal
 * @protected
 * @param {module:utils/emittermixin~Emitter} emitter An emitter for which id will be set.
 * @param {String} [id] Unique id to set. If not passed, random unique id will be set.
 */
export function _setEmitterId( emitter: Emitter, id?: string ): void {
	if ( !emitter[ _emitterId ] ) {
		emitter[ _emitterId ] = id || uid();
	}
}

/**
 * Returns emitter's unique id.
 *
 * @internal
 * @protected
 * @param {module:utils/emittermixin~Emitter} emitter An emitter which id will be returned.
 * @returns {String|undefined}
 */
export function _getEmitterId( emitter: Emitter ): string | undefined {
	return emitter[ _emitterId ];
}

interface EventNode {
	callbacks: { callback: Function; priority: number }[];
	childEvents: string[];
}

// Gets the internal `_events` property of the given object.
// `_events` property store all lists with callbacks for registered event names.
// If there were no events registered on the object, empty `_events` object is created.
function getEvents( source: Emitter ): { [ eventName: string ]: EventNode } {
	if ( !source._events ) {
		Object.defineProperty( source, '_events', {
			value: {}
		} );
	}

	return source._events!;
}

// Creates event node for generic-specific events relation architecture.
function makeEventNode(): EventNode {
	return {
		callbacks: [],
		childEvents: []
	};
}

// Creates an architecture for generic-specific events relation.
// If needed, creates all events for given eventName, i.e. if the first registered event
// is foo:bar:abc, it will create foo:bar:abc, foo:bar and foo event and tie them together.
// It also copies callbacks from more generic events to more specific events when
// specific events are created.
function createEventNamespace( source: Emitter, eventName: string ): void {
	const events = getEvents( source );

	// First, check if the event we want to add to the structure already exists.
	if ( events[ eventName ] ) {
		// If it exists, we don't have to do anything.
		return;
	}

	// In other case, we have to create the structure for the event.
	// Note, that we might need to create intermediate events too.
	// I.e. if foo:bar:abc is being registered and we only have foo in the structure,
	// we need to also register foo:bar.

	// Currently processed event name.
	let name = eventName;
	// Name of the event that is a child event for currently processed event.
	let childEventName = null;

	// Array containing all newly created specific events.
	const newEventNodes = [];

	// While loop can't check for ':' index because we have to handle generic events too.
	// In each loop, we truncate event name, going from the most specific name to the generic one.
	// I.e. foo:bar:abc -> foo:bar -> foo.
	while ( name !== '' ) {
		if ( events[ name ] ) {
			// If the currently processed event name is already registered, we can be sure
			// that it already has all the structure created, so we can break the loop here
			// as no more events need to be registered.
			break;
		}

		// If this event is not yet registered, create a new object for it.
		events[ name ] = makeEventNode();
		// Add it to the array with newly created events.
		newEventNodes.push( events[ name ] );

		// Add previously processed event name as a child of this event.
		if ( childEventName ) {
			events[ name ].childEvents.push( childEventName );
		}

		childEventName = name;
		// If `.lastIndexOf()` returns -1, `.substr()` will return '' which will break the loop.
		name = name.substr( 0, name.lastIndexOf( ':' ) );
	}

	if ( name !== '' ) {
		// If name is not empty, we found an already registered event that was a parent of the
		// event we wanted to register.

		// Copy that event's callbacks to newly registered events.
		for ( const node of newEventNodes ) {
			node.callbacks = events[ name ].callbacks.slice();
		}

		// Add last newly created event to the already registered event.
		events[ name ].childEvents.push( childEventName! );
	}
}

// Gets an array containing callbacks list for a given event and it's more specific events.
// I.e. if given event is foo:bar and there is also foo:bar:abc event registered, this will
// return callback list of foo:bar and foo:bar:abc (but not foo).
function getCallbacksListsForNamespace( source: Emitter, eventName: string ): EventNode[ 'callbacks' ][] {
	const eventNode = getEvents( source )[ eventName ];

	if ( !eventNode ) {
		return [];
	}

	let callbacksLists = [ eventNode.callbacks ];

	for ( let i = 0; i < eventNode.childEvents.length; i++ ) {
		const childCallbacksLists = getCallbacksListsForNamespace( source, eventNode.childEvents[ i ] );

		callbacksLists = callbacksLists.concat( childCallbacksLists );
	}

	return callbacksLists;
}

// Get the list of callbacks for a given event, but only if there any callbacks have been registered.
// If there are no callbacks registered for given event, it checks if this is a specific event and looks
// for callbacks for it's more generic version.
function getCallbacksForEvent( source: Emitter, eventName: string ): EventNode[ 'callbacks' ] | null {
	let event;

	if ( !source._events || !( event = source._events[ eventName ] ) || !event.callbacks.length ) {
		// There are no callbacks registered for specified eventName.
		// But this could be a specific-type event that is in a namespace.
		if ( eventName.indexOf( ':' ) > -1 ) {
			// If the eventName is specific, try to find callback lists for more generic event.
			return getCallbacksForEvent( source, eventName.substr( 0, eventName.lastIndexOf( ':' ) ) );
		} else {
			// If this is a top-level generic event, return null;
			return null;
		}
	}

	return event.callbacks;
}

// Fires delegated events for given map of destinations.
//
// @private
// * @param {Map.<utils.Emitter>} destinations A map containing
// `[ {@link module:utils/emittermixin~Emitter}, "event name" ]` pair destinations.
// * @param {utils.EventInfo} eventInfo The original event info object.
// * @param {Array.<*>} fireArgs Arguments the original event was fired with.
function fireDelegatedEvents(
	destinations: Map<Emitter, string | ( ( name: string ) => string ) | undefined>,
	eventInfo: EventInfo,
	fireArgs: any[]
) {
	for ( let [ emitter, name ] of destinations ) {
		if ( !name ) {
			name = eventInfo.name;
		} else if ( typeof name == 'function' ) {
			name = name( eventInfo.name );
		}

		const delegatedInfo = new EventInfo( eventInfo.source, name );

		delegatedInfo.path = [ ...eventInfo.path ];

		emitter.fire( delegatedInfo, ...fireArgs );
	}
}

// Helper for registering event callback on the emitter.
function addEventListener<TEvent extends BaseEvent>(
	listener: Emitter,
	emitter: Emitter,
	event: TEvent[ 'name' ],
	callback: GetCallback<TEvent>,
	options: CallbackOptions
) {
	if ( emitter._addEventListener ) {
		emitter._addEventListener( event, callback, options );
	} else {
		// Allow listening on objects that do not implement Emitter interface.
		// This is needed in some tests that are using mocks instead of the real objects with EmitterMixin mixed.
		listener._addEventListener<TEvent>.call( emitter, event, callback, options );
	}
}

// Helper for removing event callback from the emitter.
function removeEventListener( listener: Emitter, emitter: Emitter, event: string, callback: Function ): void {
	if ( emitter._removeEventListener ) {
		emitter._removeEventListener( event, callback );
	} else {
		// Allow listening on objects that do not implement Emitter interface.
		// This is needed in some tests that are using mocks instead of the real objects with EmitterMixin mixed.
		listener._removeEventListener.call( emitter, event, callback );
	}
}

/**
 * The return value of {@link ~Emitter#delegate}.
 *
 * @interface
 */
export interface EmitterMixinDelegateChain {

	/**
	 * Selects destination for {@link module:utils/emittermixin~EmitterMixin#delegate} events.
	 *
	 * @method
	 * @param {module:utils/emittermixin~Emitter} emitter An `EmitterMixin` instance which is the destination for delegated events.
	 * @param {String|Function} [nameOrFunction] A custom event name or function which converts the original name string.
	 */
	to( emitter: Emitter, nameOrFunction?: string | ( ( name: string ) => string ) ): void;
}
