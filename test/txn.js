// Txn PouchDB unit tests
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

var tap = require('tap')
var util = require('util')
var request = require('request')
var PouchDB = require('pouchdb')
var memdown = require('memdown')

var Txn = require('..')
var Txn_lib = require('../lib.js')

var TICK = typeof global.setImmediate !== 'function' ? process.nextTick : setImmediate;
var DB = process.env.db || 'txn_test';
var state = {};

// If $couchdb is defined, then test against Apache CouchDB. Otherwise, test against PouchDB.
var COUCH = process.env.couchdb
var POUCH = !COUCH

// This will be set in setup_*() and used throughout the tests.
var txn = function() { throw new Error('txn not set yet') }

tap.test('PouchDB plugin API', function(t) {
  t.type(Txn.PouchDB, 'object', 'Txn PouchDB plugin in the API')
  t.type(Txn.PouchDB.Transaction, 'function', 'Transaction initializer in the API')
  t.type(Txn.PouchDB.txn        , 'function', 'Transaction shortcut in the API')
  t.end()
})

tap.test('Setup', function(t) {
  var doc = {_id:'doc_a', val:23}

  t.plan(2)
  if (COUCH)
    setup_couchdb()
  else if (POUCH)
    setup_pouchdb()

  function done() {
    if (!state.db)
      throw new Error('Failed to create test DB')

    if (typeof txn != 'function')
      throw new Error('txn() not in the global state for further use in testing')

    if (COUCH) {
      t.type(txn.Transaction, 'function', 'CouchDB Transaction class')
      t.type(txn            , 'function', 'CouchDB txn shortcut')
    } else if (POUCH) {
      t.type(state.db.Transaction, 'function', 'PouchDB plugin loaded Transaction class')
      t.type(state.db.txn        , 'function', 'PouchDB plugin loaded txn shortcut')
    }

    t.end()
  }

  function setup_pouchdb() {
    PouchDB.plugin(Txn.PouchDB)
    var db = new PouchDB(DB, {db:memdown})
    db.put(doc, function(er, body) {
      if (er) throw er
      if (!body || !body.ok)
        throw new Error('Cannot create doc: ' + JSON.stringify(body))

      state.db = db
      state.doc_a = doc
      state.doc_a._rev = body.rev
      txn = state.db.txn.bind(state.db)
      txn.map = state.db.txn.map
      done()
    })
  }

  function setup_couchdb() {
    var url = COUCH + '/' + DB;
    request({method:'DELETE', uri:url}, function(er, resp, body) {
      if(er) throw er;
      var json = JSON.parse(body);

      var already_gone = (resp.statusCode === 404 && json.error === 'not_found');
      var deleted      = (resp.statusCode === 200 && json.ok    === true);

      if(! (already_gone || deleted))
        throw new Error('Unknown DELETE response: ' + resp.statusCode + ' ' + body);

      request({method:'PUT', uri:url}, function(er, resp, body) {
        if(er) throw er;
        var json = JSON.parse(body);

        if(resp.statusCode !== 201 || json.ok !== true)
          throw new Error('Unknown PUT response: ' + resp.statusCode + ' ' + body);

        request({method:'POST', uri:url, json:doc}, function(er, resp, body) {
          if(er) throw er;

          if((resp.statusCode !== 201 && resp.statusCode !== 202) || body.ok !== true)
            throw new Error("Cannot store doc: " + resp.statusCode + ' ' + JSON.stringify(body));

          // CouchDB just uses the main API from require().
          txn = Txn

          doc._rev = body.rev;
          state.doc_a = doc;
          state.db = COUCH + '/' + DB
          done();
        })
      })
    })
  }
})

tap.test('Required params', function(t) {
  var ID = state.doc_a._id;
  var orig = state.doc_a.val;

  var noop_ran = false;
  var noop = function(_doc, to_txn) { noop_ran = true; to_txn() }

  t.throws(function() { txn({}, noop, noop) }, "Mandatory uri");

  t.throws(function() { txn({couch:COUCH}, noop, noop) }, "Mandatory uri; missing db,id");
  t.throws(function() { txn({db   :DB   }, noop, noop) }, "Mandatory uri; missing couch,id");
  t.throws(function() { txn({couch:COUCH, db:DB}, noop, noop) }, "Mandatory uri; missing id");

  if (COUCH) {
    t.throws(function() { txn({id   :ID   }, noop, noop) }, "Mandatory uri; missing couch,db");
    t.throws(function() { txn({couch:COUCH, id:ID}, noop, noop) }, "Mandatory uri");
    t.throws(function() { txn({db:DB      , id:ID}, noop, noop) }, "Mandatory uri");
    t.equal(false, noop_ran, "CouchDB: Should never have called noop");
    t.equal(orig, state.doc_a.val, "Val should not have been updated");
    t.end()
  } else {
    t.throws(function() { txn({id:ID, uri:'http://127.0.0.1:5984/db/doc'}, noop, noop) }, 'PouchDB call with uri')
    t.throws(function() { txn({id:ID, url:'http://127.0.0.1:5984/db/doc'}, noop, noop) }, 'PouchDB call with url')
    t.doesNotThrow(function() { txn({id:ID}, noop, end) }, 'PouchDB call, only id')
  }

  function end() {
    t.equal(noop_ran, true, 'PouchDB call with id runs noop()')
    t.end()
  }
})

tap.test('Clashing parameters', function(t) {
  var url = 'http://127.0.0.1:4321/db/doc';
  var noop_ran = false;
  var noop = function(_doc, to_txn) { noop_ran = true; to_txn() }

  thrown(function() { txn({uri:url, couch:COUCH}, noop, noop) }, "Clashing params: uri,couch");
  thrown(function() { txn({url:url, couch:COUCH}, noop, noop) }, "Clashing params: url,couch");
  thrown(function() { txn({uri:url, db   :DB   }, noop, noop) }, "Clashing params: uri,db");
  thrown(function() { txn({url:url, id   :'foo'}, noop, noop) }, "Clashing params: url,id");

  thrown(function() { txn({uri:url, couch:COUCH, db:DB, id:'doc_a'}, noop, noop) }, "Clashing params, uri,couch,db,id");

  t.equal(false, noop_ran, "Noop should never run");
  t.end()

  function thrown(func, label) {
    var exception = null;
    try       { func()        }
    catch (e) { exception = e }

    var msg = COUCH ? /Clashing/ : /PouchDB disallows/
    t.ok(exception, 'Exception thrown: ' + label)
    t.match(exception && exception.message, msg, 'Exception message ' + msg + ': ' + label)
  }
})

tap.test('Update with URI', function(t) {
  function opts() {
    return COUCH ? {url: COUCH + '/' + DB + '/doc_a'}
                 : {id:'doc_a'}
  }

  txn(opts(), plus(3), function(er, doc) {
    if(er) throw er;
    t.equal(26, doc.val, "Update value in doc_a");

    txn(opts(), plus(6), function(er, doc) {
      if(er) throw er;
      t.equal(32, doc.val, "Second update value in doc_a");

      state.doc_a = doc;
      t.end()
    })
  })
})

tap.test('Update with parameters', function(t) {
  if (COUCH)
    var opts = {couch:COUCH, db:DB, id:'doc_a'}
  else if (POUCH)
    var opts = {id:'doc_a'}

  txn(opts, plus(-7), function(er, doc) {
    if(er) throw er;

    t.equal(25, doc.val, "Update via couch args");
    t.end()
  })
})

tap.test('Encoding', function(t) {
  var id = 'Doc Made At 2016-03-04T17:16:59.214Z'
  if (COUCH)
    var opts = {couch:COUCH, db:DB, id:id, create:true}
  else if (POUCH)
    var opts = {id:id, create:true}

  txn(opts, change_odd_id, changed)

  function change_odd_id(doc, to_txn) {
    doc.id_seen = doc._id
    return to_txn()
  }

  function changed(er, doc) {
    if (er) throw er

    t.equal(doc._id    , id, 'Document _id is correct and not encoded')
    t.equal(doc.id_seen, id, 'ID copied over in the transaction is correct and not encoded')
    t.end()
  }
})

tap.test('Update with defaults', function(t) {
  // Set TXN to use for these tests, to test defaultable for CouchDB and PouchDB. All subsequent tests will assume txn()
  // has these defaults. Since PouchDB needs only the id option, it is harder to confirm its defaultable behavior. So
  // use the test_callback feature.
  if (COUCH) {
    txn = txn.defaults({couch:COUCH, db:DB})
    var TXN = txn
  } else if (POUCH) {
    PouchDB.plugin(Txn.defaults({test_callback:checker}).PouchDB)

    // NOTE: Pouch seems to re-use a database if the name is the same. If that ever changes, def_db will be missing doc_a.
    var def_db = new PouchDB(DB, {db:memdown})
    var TXN = def_db.txn.bind(def_db)
  }

  var op_ran = false
  function checker() { op_ran = true }

  TXN({id:'doc_a'}, plus(11), function(er, doc) {
    if(er) throw er;

    t.equal(36, doc.val, "Defaulted parameters: couch and db")

    if (POUCH)
      t.equal(op_ran, true, 'Defaultable PouchDB plugin ran test_callback')

    state.doc_a = doc;
    t.end()
  })
})

tap.test('Operation timeout', function(t) {
  var val = state.doc_a.val;
  txn({id:'doc_a', timeout:200}, waitfor(100), function(er, doc) {
    t.equal(er, null, 'No problem waiting 200ms for a 100ms operation')

    txn({id:'doc_a', timeout:200}, waitfor(300), function(er, doc) {
      t.match(er && er.message, /timeout/, 'Expect a timeout error for a long operation')
      t.end()
    })
  })
})

tap.test('Create a document', function(t) {
  txn({id:'no_create'}, setter('foo', 'nope'), function(er, doc) {
    t.equal(doc, undefined, "Should not have a doc to work with")
    if (COUCH)
      t.match(er && er.error, /not_found/, 'Error on unknown doc ID')
    else if (POUCH)
      t.match(er && er.name, /not_found/, 'Error on unknown doc ID')

    txn({id:'create_me', create:true}, setter('foo', 'yep'), function(er, doc, txr) {
      if (er) throw er

      t.equal(er, null, 'No problem creating a doc with create:true')
      t.equal(doc.foo, 'yep', 'Created doc data looks good')
      t.equal(Object.keys(doc).length, 3, "No unexpected fields in doc create")
      t.equal(txr.is_create, true, 'Transaction result indicates document created')

      txn({id:'doc_a'}, setter('creation','test'), function(er, doc, txr) {
        if (er) throw er
        t.equal(txr.is_create, false, 'Transaction result indicates creation not necessary')
        t.end()
      })
    })
  })
})

tap.test('Noop create', function(t) {
  t.plan(4)

  txn({id:'noop-create', create:true}, nothing, stored)
  function nothing(doc, to_txn) {
    to_txn()
  }

  function stored(er, doc, txr) {
    if (er) throw er
    t.equal(txr.stores, 1, 'Txn stored an empty creation document')

    if (POUCH)
      state.db.get('noop-create', function(er, doc) {
        check(doc || {})
      })
    else if (COUCH)
      request({url:COUCH+'/'+DB+'/noop-create', json:true}, function(er, res) {
        check(res.body || {})
      })
  }

  function check(doc) {
    t.equal(doc._id, 'noop-create', 'Created doc is definitely in the DB')
    t.type(doc._rev, 'string', 'Created doc has a revision')
    t.equal(Object.keys(doc).length, 2, 'Doc only has _id and _rev keys')
    t.end()
  }
})

tap.test('Timestamps', function(t) {
  txn({id:'doc_a'}, plus(-6), function(er, doc) {
    if(er) throw er;

    t.equal(doc.val, 30, "Normal update works")
    t.equal(doc.created_at, undefined, 'Normal update has no create timestamp')
    t.equal(doc.updated_at, undefined, 'Normal update has no update timestamp')

    txn({id:'doc_a', timestamps:true}, plus(2), function(er, doc) {
      if(er) throw er;

      t.equal(doc.val, 32, "Timestamps update works")
      t.equal(doc.created_at, undefined, "Updating existing docs does not add creation timestamp")
      t.type(doc.updated_at, 'string', "Update with timestamps")

      state.doc_a = doc

      txn({id:'stamps', create:true, timestamps:true}, setter('val', 10), function(er, doc) {
        if(er) throw er;

        t.equal(doc.val, 10, "Timestamps create works")
        t.type(doc.created_at, 'string', "Create with created_at")
        t.type(doc.updated_at, 'string', "Create with updated_at")
        t.equal(doc.updated_at, doc.created_at, "Creation and update stamps are equal")

        t.end()
      })
    })
  })
})

tap.test('Timestamps and optimizations', function(t) {
  var runs = 0
  var created_at = null
  var updated_at = null

  setTimeout(go, 5)
  setTimeout(go, 250)

  function go() {
    txn({id:'test_ts', create:true, timestamps:true}, noop, done)
  }

  function noop(doc, to_ts) {
    doc.x = true
    return to_ts()
  }

  function done(er, doc, txr) {
    if (er) throw er

    runs += 1
    if (runs == 1) {
      t.equal(txr.stores, 1, 'Created document test_ts with timestamps')
      created_at = doc.created_at
      updated_at = doc.updated_at
    } else {
      t.equal(doc.created_at, created_at, 'No create change despite an update with timestamps')
      t.equal(doc.updated_at, updated_at, 'No update change despite an update with timestamps')
      t.equal(txr.stores, 0, 'No store for second update')
      t.end()
    }
  }
})

tap.test('Timestamps with conflicting fields', function(t) {
  var birthday = '2015-06-04T01:38:28.943Z'
  txn({id:'Isla', create:true, timestamps:true}, make_old_ts, done)
  function make_old_ts(doc, to_txn) {
    doc.created_at = birthday
    return to_txn()
  }
  function done(er, doc) {
    if (er) throw er
    t.equal(doc.created_at, birthday, 'Txn does not overwrite an existing .created_at field')
    t.type(doc.updated_at, 'string', 'Txn did create updated_at normally')
    t.notEqual(doc.updated_at, doc.created_at, 'Timestamps are different since created_at was already there')
    t.end()
  }
})

tap.test('Preloaded doc with no conflicts', function(t) {
  txn({id:'doc_b', create:true}, setter('type','first'), function(er, doc_b, txr) {
    if(er) throw er;
    t.equal(doc_b.type, 'first', 'Create doc for preload')
    t.equal(txr.tries, 1, 'Takes 1 try for doc update')
    t.equal(txr.fetches, 1, 'Takes 1 fetch for doc update')

    var ops = 0;
    function update_b(doc, to_txn) {
      ops += 1;
      doc.type = 'preloaded';
      return to_txn();
    }

    txn({doc:doc_b}, update_b, function(er, doc, txr) {
      if(er) throw er;

      t.equal(doc.type, 'preloaded', 'Preloaded operation runs normally')
      t.equal(ops, 1, 'Only one op for preloaded doc without conflicts')
      t.equal(txr.tries, 1, 'One try for preloaded doc without conflicts')
      t.equal(txr.fetches, 0, 'No fetches for preloaded doc without conflicts')

      state.doc_b = doc
      t.end()
    })
  })
})

tap.test('Preloaded doc with funny name', function(t) {
  var doc1 = {'_id':'this_doc', 'is':'nothing'}
  var doc2 = {'_id':'this_doc/has:slashes!youknow?'}

  if (POUCH)
    state.db.bulkDocs([doc1, doc2], function(er, body) {
      if (er)
        throw er
      if (!body || !body[0] || !body[0].id || !body[0].rev)
        throw new Error('Bad bulk docs store: ' + JSON.stringify(body))
      if (!body || !body[1] || !body[1].id || !body[1].rev)
        throw new Error('Bad bulk docs store: ' + JSON.stringify(body))
      stored()
    })
  else if (COUCH)
    request({method:'POST', uri:COUCH+'/'+DB+'/_bulk_docs', json:{docs:[doc1,doc2]}}, function(er, res) {
      if (er)
        throw er
      if (!res.body || !res.body[0] || !res.body[0].id || !res.body[0].rev)
        throw new Error('Bad bulk docs store: ' + JSON.stringify(res.body))
      if (!res.body || !res.body[1] || !res.body[1].id || !res.body[1].rev)
        throw new Error('Bad bulk docs store: ' + JSON.stringify(res.body))
      stored()
    })

  function stored() {
    if (POUCH)
      state.db.get('this_doc/has:slashes!youknow?', function(er, doc) {
        if (er) throw er
        ready(doc)
      })
    else if (COUCH)
      request({url:COUCH+'/'+DB+'/this_doc%2fhas:slashes!youknow%3f', json:true}, function(er, res) {
        if(er) throw er;
        ready(res.body)
      })
  }

  function ready(doc) {
    var ops = 0;
    function updater(doc, to_txn) {
      ops += 1;
      doc.type = 'preloaded slashy';
      return to_txn();
    }

    txn({doc:doc}, updater, function(er, this_doc, txr) {
      if(er) throw er;

      t.equal('preloaded slashy', this_doc.type, 'Create doc for preload');
      t.equal(ops, 1, 'One op for preloaded doc with funny name')
      t.equal(txr.tries, 1, 'One try for doc update')
      t.equal(txr.fetches, 0, 'No fetches for preloaded doc with funny name')

      t.end()
    })
  }
})

tap.test('Preloaded doc with conflicts', function(t) {
  var old_rev = state.doc_b._rev;
  var old_type = state.doc_b.type;

  var old_b = JSON.parse(JSON.stringify(state.doc_b));
  var new_b = {_id:'doc_b', _rev:old_rev, 'type':'manual update'};

  var url = COUCH + '/' + DB + '/doc_b';
  if (COUCH)
    request({method:'PUT', uri:url, json:new_b}, function(er, res) {
      if (er) throw er
      if (res.statusCode != 201)
        throw new Error('Bad PUT ' + JSON.stringify(res.body))
      ready(res.body.rev)
    })
  else if (POUCH)
    state.db.put(new_b, function(er, result) {
      if (er) throw er
      ready(result.rev)
    })

  function ready(new_rev) {
    // Lots of stuff going on, so make a plan.
    var updater_tests = 3
    var post_tests = 4
    t.plan(updater_tests*2 + post_tests)

    // At this point, the new revision is committed but tell Txn to assume otherwise.
    var new_type = 'manual update'

    var ops = 0;
    function updater(doc, to_txn) {
      ops += 1;
      t.equal(ops == 1 || ops == 2, true, "Should take 2 ops to commit a preload conflict: " + ops)

      if(ops == 1) {
        t.equal(old_rev , doc._rev, "First op should still have old revision")
        t.equal(old_type, doc.type, "First op should still have old value")
      } else {
        t.equal(new_rev , doc._rev, "Second op should have new revision")
        t.equal(new_type, doc.type, "Second op should have new type")
      }

      doc.type = 'preload txn';
      return to_txn();
    }

    txn({id:'doc_b', doc:old_b}, updater, function(er, final_b, txr) {
      if(er) throw er;

      t.equal(ops, 2, 'Two ops for preloaded txn with conflicts')
      t.equal(txr.tries, 2, 'Two tries for preloaded doc with conflicts')
      t.equal(txr.fetches, 1, 'One fetch for preloaded doc with conflicts')
      t.equal(final_b.type, 'preload txn', 'Preloaded operation runs normally')

      state.doc_b = final_b
      t.end()
    })
  }
})

tap.test('Preloaded doc creation', function(t) {
  var doc = {_id: "preload_create", worked: false};

  txn({doc:doc, create:true}, setter('worked', true), function(er, doc, txr) {
    if(er) throw er;

    t.equal(txr.tries, 1, "One try to create a doc with preload")
    t.equal(txr.fetches, 0, "No fetches to create a doc with preload")
    t.equal(true, doc.worked, "Operation runs normally for preload create")
    t.end()
  })
})

tap.test('Map function', function(t) {
  if (! POUCH) {
    t.ok(true, 'TODO: CouchDB map support not yet implemented')
    return t.end()
  }

  txn({doc:{_id:'exists'}, create:true}, setter('score', 5), function(er, old_doc, txr) {
    if (er)
      throw er

    var req = [ {id:'create-me', create:true}
              , {doc:old_doc}
              , {id:old_doc._id} // Do old_doc twice.
              ]
    
    state.db.txn_map(req, do_doc, done)

    function do_doc(doc, to_txn) {
      doc.score = 1 + (doc.score || 0)
      return to_txn()
    }

    function done(er, docs, txrs) {
      if (er)
        throw er

      t.equal(docs.length, 3, 'Did 3 docs')
      t.equal(txrs.length, 3, 'Got 3 transaction results')

      t.equal(txrs[0].is_create, true, 'First doc was created')
      t.equal(docs[0].score, 1, 'First doc got a score of 1')
      t.equal(txrs[0].tries, 1, 'One try to create the first doc')
      t.equal(txrs[0].stores, 1, 'Successful create with one store op')
      t.equal(txrs[0].fetches, 1, 'No fetches for a create')

      t.equal(docs[1]._id, docs[2]._id, 'Second two ops were for the same doc')
      t.ok(docs[1].score == 6 || docs[2].score == 6, 'One of the docs has a score of 6')
      t.ok(docs[1].score == 7 || docs[2].score == 7, 'One of the docs has a score of 7')

      t.end()
    }
  })
})

tap.test('Concurrent transactions', function(t) {
  var doc = { _id:'conc' }
  var bad_rev = '1-abc'

  if (COUCH)
    request({method:'PUT', uri:COUCH+'/'+DB+'/conc', json:doc}, function(er, res) {
      if (er) throw er
      t.equal(res.statusCode, 201, 'Good conc creation')
      t.notEqual(res.body.rev, bad_rev, 'Make sure '+bad_rev+' is not the real revision in CouchDB')
      ready(res.body.rev)
    })
  else if (POUCH)
    state.db.put(doc, function(er, result) {
      if (er) throw er
      ready(result.rev)
    })

  function ready(rev) {
    t.notEqual(rev, bad_rev, 'The real revision is not '+bad_rev)

    var _txn = txn
    if (COUCH)
      _txn = txn.defaults({ 'delay':8, 'request':track_request })

    var opts = {id:'conc'}
    _txn({id:'conc'}, setter('done', true), function(er, doc, txr) {
      if(er) throw er

      t.equal(doc.done, true, 'Setter should have worked')

      // TODO: Really, there should be a similar mechanism to fool PouchDB. Perhaps a plugin to override .get().
      if (COUCH)
        t.equal(txr.tries, 5, 'The faux request wrapper forced this to require many tries')

      t.end()
    })

    // Return the same response for the document over and over.
    var gets = 0;
    function track_request(req, callback) {
      if(req.method != 'GET' || ! req.uri.match(/\/conc$/))
        return request.apply(this, arguments);

      gets += 1;
      if(gets > 3)
        return request.apply(this, arguments);

      // Return the same thing over and over to produce many conflicts in a row.
      return callback(null, {statusCode:200}, JSON.stringify({_id:'conc', _rev:bad_rev}));
    }
  }
})

tap.test('After delay', function(t) {
  var set = setter('x', 1);
  var start, end, duration;

  var num = 0;
  function doc() {
    num += 1;
    return {"_id":"after_"+num};
  }

  start = new Date;
  txn({doc:doc(), create:true, after:null}, set, function(er) {
    if(er) throw er;

    end = new Date;
    var base_duration = end - start;

    start = new Date;
    txn({doc:doc(), create:true, after:0}, set, function(er) {
      if(er) throw er;

      end = new Date;
      duration = end - start;

      if(base_duration < 10)
        t.equal(duration < 10, true, 'after=0 should run immediately; duration = ' + duration)
      else
        t.equal(almost(0.25, duration, base_duration), true, 'after=0 should run immediately (about ' + base_duration + ')')

      // The "after" value should be noticeable in tests, but not take too long: about 100% of the base latency.
      var after = Math.max(250, base_duration * 1.00)
      start = new Date;
      txn({doc:doc(), create:true, after:after}, set, function(er) {
        if(er) throw er;

        end = new Date;
        duration = end - start;
        var delay_duration = duration - base_duration;
        t.equal(almost(0.15, delay_duration, after), true, "after parameter delays the transaction: "+delay_duration+' vs '+after)

        t.end()
      })
    })
  })
})

tap.test('Problematic doc ids', function(t) {
  var tests = [ {'_id':'doc with space'}
              , 'has space'
              , 'has!bang'
              , {'_id':'doc with ! bang'}
              , 'The "quick" (?) brown หมาจิ้งจอก jumps over the lazy dog!'
              ]

  // Per test, make_doc() does 1 check; result does 5 checks for couchdb, 4 for pouchdb.
  t.plan(tests.length * (COUCH ? 1+5 : 1+4))

  check_id()
  function check_id() {
    var check = tests.shift()
    if(!check)
      return t.end()

    if(typeof check == 'string')
      var opts = {'create':true, 'id':check}
    else
      var opts = {'create':true, 'doc':check}

    var id = check._id || check
    var value = Math.random()
    txn(opts, make_doc, result)

    function make_doc(doc, to_txn) {
      t.equal(doc._id, id, 'Incoming doc ID should be right')
      doc.key = value
      return to_txn()
    }

    function result(er, doc, txr) {
      if(er) throw er
      var id_re = encodeURIComponent(id)
      id_re = id_re.replace(/\(/g, '\\(').replace(/\)/g, '\\)')
      id_re = new RegExp('/' + id_re + '$')

      t.equal(doc._id, id, 'Created doc ID is right')
      if (COUCH)
        t.match(txr.uri, id_re, 'Transaction URL uses the right ID')

      var doc_url = COUCH + '/' + DB + '/' + encodeURIComponent(id)

      if (COUCH)
        request({url:doc_url, json:true}, function(er, res) {
          if(er) throw er
          t.equal(res.statusCode, 200, 'Got the doc with problematic ID: '+JSON.stringify(id))
          t.equal(res.body._id, id, 'Doc has the expected id: '+JSON.stringify(id))
          t.equal(res.body.key, value, 'Doc has the planted value: '+JSON.stringify(id))
          check_id()
        })

      else if (POUCH)
        state.db.get(id, function(er, doc) {
          t.equal(er, null, 'No problem fetching ID: '+JSON.stringify(id))
          t.equal(doc._id, id, 'Doc has expected ID: '+JSON.stringify(id))
          t.equal(doc.key, value, 'Doc has the planted value: '+JSON.stringify(id))
          check_id()
        })
    }
  }
})

tap.test('Database errors', function(t) {
  var _txn = txn
  if (COUCH)
    _txn = txn.defaults({'request':req_fail})

  _txn({'id':'error_doc'}, setter('foo', 'bar'), result)

  // Force a CouchDB failure.
  function req_fail(req, callback) {
    Txn_lib.req_couch({'method':'PUT', 'uri':COUCH+'/_illegal'}, function(er, res, result) {
      t.ok(er, 'Got a req_couch error')
      t.ok(er.statusCode == 400 || er.statusCode == 403, 'HTTP error status embedded in req_couch error')
      t.ok(er.error == 'illegal_database_name' || er.error == 'forbidden', 'CouchDB error object embedded in req_couch error')
      return callback(er, res, result)
    })
  }

  function result(er, doc, txr) {
    t.ok(er, 'Got a txn error')

    if (COUCH) {
      t.ok(er.statusCode == 400 || er.statusCode == 403, 'HTTP error status embedded in txn error')
      t.ok(er.error == 'illegal_database_name' || er.error == 'forbidden', 'CouchDB error object embedded in txn error')
    } else if (POUCH) {
      t.equal(er.status, 404, 'PouchDB error embedded in a txn error: status')
      t.equal(er.name, 'not_found', 'PouchDB error object embedded in txn error: name')
    }

    t.end()
  }
})

// TODO: This test is now very, very slow with newer Node.js on a more modest MacBook. I think the only real point of the
// test is to make sure that txn does not always run in the same tick. That is a more straightforward test, but not
// yet implemented.
if (0)
tap.test('Avoid smashing the stack', function(t) {
  t.plan(2) // Check that the limit is found + check that it is exceeded.

  var depth_limit
  find_limit(1)

  function find_limit(depth) {
    if(depth > 25000)
      throw new Error('Cannot find stack depth limit after 25,000 function calls')

    try { find_limit(depth + 1) }
    catch (er) {
      depth_limit = depth * 5
      setTimeout(find_txn_limit, 100)
    }
  }

  function find_txn_limit() {
    t.equal(depth_limit > 1, true, 'Depth limit found ('+depth_limit+')')

    // The idea is to produce zero i/o so Txn always calls the callback immediately, never allowing the stack to unwind.
    var no_change = function(doc, to_txn) { return to_txn() }
    var error = null

    var opts = COUCH ? function() { return {'couch':COUCH, 'db':DB, 'doc':{'_id':'txn_limit_doc'}, 'timeout':60*1000} }
                     : function() { return {                        'doc':{'_id':'txn_limit_doc'}, 'timeout':60*1000} }

    //console.log('depth_limit = %d', depth_limit)
    txn_depth(1)
    function txn_depth(depth) {
      if(depth >= depth_limit)
        return check_results()

      txn(opts(), no_change, function(er) {
        if(er) throw er;
        try { txn_depth(depth + 1) } // Try one level deeper.
        catch (er) {
          error = er
          TICK(check_results)
        }
      })
    }

    function check_results() {
      //if(error) console.error('Error: %s', error.stack)
      t.equal(error, null, 'Txn called back deeper than the stack allows')
      t.end()
    }
  }
})


//
// Some helper operations
//

function plus(X) {
  return adder;
  function adder(doc, to_txn) {
    if(!doc.val)
      return to_txn(new Error('No value'));
    doc.val += X;
    return to_txn();
  }
}

function setter(K, V) {
  return set;
  function set(doc, to_txn) {
    doc[K] = V;
    return to_txn();
  }
}

function waitfor(X) {
  return finisher;
  function finisher(doc, to_txn) {
    setTimeout(finish, X);
    function finish() {
      return to_txn();
    }
  }
}

function thrower(er) {
  return thrower;
  function thrower() {
    if(er) throw er;
  }
}

//
// Utilities
//

function almost(margin, actual, expected) {
  var delta = Math.abs(actual - expected)
  var real_margin = delta / expected
  return (real_margin <= margin)
}

// TODO
//
// db.txn('doc_id', operation, callback)
// db.txn({_id:'foo'}) throws because it is probably a bad call
// db.txn({doc:{_id:'foo'}}) works with the standard shortcut
//
// t = require('txn')
// db = new PouchDB('foo')
// t({db:db, id:'blah'}) works because it checks (db instanceof PouchDB)

function I(obj) {
  return util.inspect(obj, {colors:true, depth:10})
}
