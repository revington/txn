// Transaction
//
// Copyright 2011 Jason Smith, Jarrett Cruger and contributors
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//
//        http://www.apache.org/licenses/LICENSE-2.0
//
//    Unless required by applicable law or agreed to in writing, software
//    distributed under the License is distributed on an "AS IS" BASIS,
//    WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
//    See the License for the specific language governing permissions and
//    limitations under the License.

var util = require('util')
  , debug = require('debug')
  , events = require('events')
  , assert = require('assert')
  , obj_diff = require('obj_diff').defaults({couchdb: true})

var EventEmitter = events.EventEmitter2 || events.EventEmitter
var TICK = typeof global.setImmediate !== 'function' ? process.nextTick : setImmediate

require('defaultable').def(module,
  { 'log'                : debug('txn:couchdb')
  , 'pouchdb_log'        : debug('txn:pouchdb')
  , 'timestamps'         : false
  , 'timestamp_generator': function() { return new Date(); }
  , 'create'             : false
  , 'max_tries'          : 5
  , 'after'              : null
  , 'delay'              : 100
  , 'timeout'            : 15 * 1000
  , 'operation'          : null
  , 'strictSSL'          : true
  , 'maxSockets'         : 100
  , 'proxy'              : null
  , 'req'                : null
  , 'pouchdb'            : null
  , 'couch'              : null
  , 'db'                 : null
  , 'id'                 : null
  , 'test_callback'      : null
  }, function(module, exports, DEFAULT, require) {


var lib = require('./lib');

// The main API is the shortcut function, but the object API is also available.
module.exports = couch_doc_txn
module.exports.Txn = Transaction
module.exports.Transaction = Transaction
module.exports.PouchDB = {Transaction:Transaction, txn:pouch_doc_txn}


function pouch_doc_txn(opts, operation, callback) {
  opts = opts || {}
  opts.pouchdb = this
  return couch_doc_txn(opts, operation, callback)
}

function couch_doc_txn(fetch_req, operation, callback) {
  assert.equal('function', typeof callback, 'Need callback');

  // Allow specifying options in the req object.
  var opts = {};
  for (var key in DEFAULT)
    if(key !== 'req' && key !== 'operation')
      if(key in fetch_req) {
        opts[key] = fetch_req[key];
        delete fetch_req[key];
      }

  if(fetch_req.doc) {
    opts.doc = fetch_req.doc;
    delete fetch_req.doc;
  }

  opts.req       = fetch_req;
  opts.operation = operation;

  if (opts.pouchdb)
    var txn = new PouchTransaction(opts)
  else
    var txn = new Transaction(opts)

  txn.on('timeout', function() {
    var err = new Error('Transaction ('+txn.name+') timeout');
    err.timeout = true;
    return callback(err);
  })

  txn.on('exhausted', function(tries) {
    var err = new Error('Transaction ('+txn.name+') exhausted after '+tries+' conflicts');
    err.conflict = true;
    err.tries = tries;
    return callback(err);
  })

  txn.on('error', function(er) {
    return callback(er);
  })

  txn.on('done', function(doc) {
    // A huge string of no-op changes can push the stack too deeply.
    TICK(function() {
      callback(null, doc, txn);
    })
  })

  txn.start();
  return txn;
}


util.inherits(Transaction, EventEmitter);
function Transaction (opts) {
  var self = this;
  EventEmitter.call(self);

  self.type = 'couchdb'

  self.req                 = opts.req                 || DEFAULT.req;
  self.couch               = opts.couch               || DEFAULT.couch;
  self.db                  = opts.db                  || DEFAULT.db;
  self.id                  = opts.id                  || DEFAULT.id;
  self.doc                 = opts.doc                 || null;
  self.operation           = opts.operation           || DEFAULT.operation;
  self.timeout             = opts.timeout             || DEFAULT.timeout;
  self.delay               = opts.delay               || DEFAULT.delay;
  self.log                 = opts.log                 || DEFAULT.log;
  self.timestamp_generator = opts.timestamp_generator || DEFAULT.timestamp_generator;

  // These can be falsy.
  self.after      = ('after'      in opts) ? opts.after      : DEFAULT.after;
  self.create     = ('create'     in opts) ? opts.create     : DEFAULT.create;
  self.timestamps = ('timestamps' in opts) ? opts.timestamps : DEFAULT.timestamps;
  self.max_tries  = ('max_tries'  in opts) ? opts.max_tries  : DEFAULT.max_tries;
} // Transaction


Transaction.prototype.start = function() {
  var self = this;

  if(!self.req)
    return self.emit('error', new Error('Required req object'));

  if(self.doc && !self.doc._id)
    return self.emit('error', new Error('Required doc._id value'));
  if(self.doc)
    self.id = self.doc._id

  // TODO:
  // ID Encoding stuff should not be in this library. Or, at least it should not be here. The ID should be encoded in the HTTP code.
  if(self.id && self.pouchdb)
    self.log('Skip ID encoding for PouchDB')
  else if (self.id)
    self.id = lib.enc_id(self.id)

  self.prep_params()

  assert.ok(self.max_tries > 0, 'max_tries must be 1 or greater');
  assert.ok(self.timeout > 0, 'timeout must be 1 or greater');
  assert.equal(typeof self.operation, 'function', 'Data operation required');

  self.name = self.operation.name || 'Untitled';
  self.fetches = 0;
  self.stores = 0
  self.tries = 0;
  return self.attempt();
}

// Prepare for an HTTP transaction.
Transaction.prototype.prep_params = function() {
  var self = this

  var has_uri   = !! (self.req.uri || self.req.url);
  var has_couch = !! (self.couch || self.db || self.id);

  assert.ok(has_uri || has_couch, 'Must provide .uri or .couch/.db/.id parameters');
  if(has_uri)
    assert.equal(false, has_couch, 'Clashing .uri/.url and .couch/.db/.id parameters');
  if(has_couch) {
    assert.ok(self.couch && self.db && self.id, 'Must set all .couch, .db, and .id parameters');
    assert.equal(false, has_uri, 'Clashing .uri/.url and .couch/.db/.id parameters');
  }

  self.uri = self.req.uri || self.req.url || [self.couch, self.db, self.id].join('/');
  assert.ok(self.uri, 'Must set .uri or else .couch, .db, and .id');
}

Transaction.prototype.attempt = function() {
  var self = this;

  if(self.tries >= self.max_tries) {
    self.log('Too many tries ('+self.name+'): ' + self.tries);
    return self.emit('exhausted', self.tries);
  }

  if(self.retry_timer)
    return self.emit('error', new Error('retry_timer already set: ' + self.name));

  var delay;
  if(self.tries == 0 && ! self.after)
    return go(); // No delay.
  else if(self.tries == 0 && self.after) {
    delay = self.after;
    self.log('Initial delay before first run ('+self.name+'): ' + delay);
    self.retry_timer = setTimeout(go, delay);
  }
  else {
    delay = self.delay * Math.pow(2, self.tries);
    self.log('Delay until next attempt ('+self.name+'): ' + delay);
    self.retry_timer = setTimeout(go, delay);
  }

  function go() {
    clearTimeout(self.retry_timer);
    delete self.retry_timer;

    self.tries += 1;
    self.emit('attempt', self.tries);
    self.run();
  }
}

Transaction.prototype.run = function() {
  var self = this;
  self.log('Transaction %s (%s/%s): %s', self.name, self.tries, self.max_tries, self.uri || self.id)

  if(self.doc) {
    self.log('Skip fetch, assuming known doc: ' + self.doc._id)
    return run_op(self.doc, !('_rev' in self.doc))
  }

  self.fetches += 1;
  self.get(function (er, res, couch_doc) {
    var is_create = !!self.create && res.statusCode == 404 && couch_doc.error == 'not_found';
    if(er && !is_create)
      return self.emit('error', er);

    if(is_create) {
      self.is_create = true
      couch_doc = { "_id": decodeURIComponent(self.id || self.uri_to_id(self.uri)) };
      self.log('Create new doc: %j', couch_doc)
    } else
      self.is_create = false

    return run_op(couch_doc, is_create);
  })

  function run_op(doc, is_create) {
    if(!doc._id)
      return self.emit('error', new Error('No _id: ' + lib.JS(doc)));
    if(!doc._rev && !is_create)
      return self.emit('error', new Error('No _rev: ' + lib.JS(doc)));

    self.log('Run operation (create=%j): %s', is_create, doc._id)
    delete self.doc; // In case it was provided.

    var original = { "doc": lib.JDUP(doc)
                   , "id" : doc._id
                   , "rev": doc._rev
                   };

    if(self.op_timer)
      return self.emit('error', new Error('op_timer already set: ' + self.name));

    var already_done = false;
    self.op_timer = setTimeout(on_timeout, self.timeout);
    function on_timeout() {
      self.op_timer = null;
      already_done = true;
      return self.emit('timeout');
    }

    // Execute the operation.
    self.operation(doc, op_done);

    function op_done(er, new_doc) {
      clearTimeout(self.op_timer);
      delete self.op_timer;

      if(already_done) {
        self.log('Ignore operation after timeout');
        return self.emit('ignore');
      } else
        already_done = true;

      if(er)
        return self.emit('error', er);

      if(new_doc) {
        self.log('Use new doc: %j', new_doc)
        self.emit('replace', doc, new_doc);
        doc = new_doc;
      }

      var diff = obj_diff(original.doc, doc)
      self.log('Operation diff (%s): %j', self.name, diff)

      if(!self.is_create && diff.atmost()) {
        self.log('Skip txn update for unchanged doc: ' + original.id);
        return self.emit('done', doc);
      }

      self.emit('change', diff);

      doc._id = original.id;
      if(original.rev)
        doc._rev = original.rev;

      if(!! self.timestamps) {
        doc.updated_at = JSON.stringify(self.timestamp_generator()).replace(/"/g, '');
        if(is_create)
          doc.created_at = doc.created_at || doc.updated_at;
      }

      self.log('Update transaction (%s): %s', self.name, self.uri || self.id)
      self.stores += 1
      self.put(doc, function(er, res, result) {
        if(er && res && res.statusCode === 409 && result.error === "conflict") {
          // Retryable error.
          self.log('Conflict: '+self.name);
          self.emit('conflict', self.tries);
          return self.attempt();
        }

        if(er)
          // Normal error, non-retryable.
          return self.emit('error', er);

        // Success.
        if (DEFAULT.test_callback)
          DEFAULT.test_callback() // The only purpose for this is for the test suite to confirm that DEFAULT is working.

        doc._rev = result.rev;
        return self.emit('done', doc);
      })
    }
  } // run_op
}

Transaction.prototype.get = function(callback) {
  var self = this
  self.log('Fetch doc: ' + (self.id || self.uri_to_id(self.uri)))

  self.req.method = 'GET';
  self.req.uri = self.uri;
  delete self.req.url;

  return lib.req_couch(self.req, callback)
}

Transaction.prototype.put = function(doc, callback) {
  var self = this
  var update_req = {method:'PUT', uri:self.uri, json:doc}
  self.log('Update request: %j', update_req)
  return lib.req_couch(update_req, callback)
}

Transaction.prototype.cancel = function() {
  clearTimeout(self.retry_timer);
  clearTimeout(self.op_timer);

  self.log('Cancelling transaction try: ' + self.tries);
  self.retry_timer = null;
  self.op_timer    = null;

  self.emit('cancel', self.tries);
}


// The caller might override this if using some unknown URL scheme.
Transaction.prototype.uri_to_id = function(uri) {
  var parts = uri.split('/');
  return parts[ parts.length - 1 ];
}


//
// PouchTransaction is a thin subclass of Transaction
//

util.inherits(PouchTransaction, Transaction)
function PouchTransaction (opts) {
  var self = this
  Transaction.call(self, opts)

  self.type = 'pouch'
  self.log = opts.log || DEFAULT.pouchdb_log
  self.pouchdb = opts.pouchdb || DEFAULT.pouchdb
}

PouchTransaction.prototype.prep_params = function() {
  var self = this

  self.log('Prep PouchDB')
  assert.ok(!self.req.uri && !self.req.url, 'PouchDB disallows .url or .uri parameters')
  assert.ok(self.id, 'Must provide .id parameter')
  assert.ok(self.pouchdb, 'Must provide .pouchdb parameter')
}

PouchTransaction.prototype.get = function(callback) {
  var self = this
  self.log('Fetch doc: %s', self.id)

  return self.pouchdb.get(self.id, function(er, doc) {
    // The callback wants request-style [er, response, body] parameters.
    if (er && (!er.status || !er.name))
      callback(er) // Unknown error: .status or .name is missing.
    else if (er)
      callback(er, {statusCode:er.status}, {error:er.name}) // e.g. status=404 name=not_found
    else
      callback(null, {statusCode:200}, doc)
  })
}

PouchTransaction.prototype.put = function(doc, callback) {
  var self = this
  self.log('Put doc: %j', doc)

  // The callback wants request-style [er, response, body] parameters.
  return self.pouchdb.put(doc, function(er, result) {
    if (er && (!er.status || !er.name))
      callback(er) // Unknown error: .status or .name is missing.
    else if (er)
      callback(er, {statusCode:er.status}, {error:er.name}) // e.g. status=409 name=conflict
    else
      callback(null, {statusCode:201}, result)
  })
}


}, require) // defaultable
