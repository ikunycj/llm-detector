import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseWorker, sourceID, recordKey, workerClient, sourceName } from './sources.ts'
test('equal remote ids remain distinct between browser, cloud and different Workers',()=>{
 const sources=['local','cloud','worker:a','worker:b']
 assert.equal(new Set(sources.map(source=>recordKey({id:'same',source}))).size,4)
 const worker=parseWorker({id:'a',name:' Lab ',url:'https://worker.test/',key:'fixture-key'})
 const client=workerClient(worker)
 assert.equal(sourceID(client),'worker:a')
 assert.equal(sourceName('worker:a',[client]),'自建 Worker · Lab')
 assert.equal(client.baseURL,'https://worker.test')
 assert.equal(client.token,'fixture-key')
})
test('Worker addresses and keys are validated before storing or sending',()=>{
 const base={id:'a',name:'lab',url:'https://worker.test',key:'fixture'}
 for(const patch of [{url:'file:///etc/passwd'},{url:'https://user:key@host'},{url:'https://host?key=secret'},{url:'https://host/#secret'},{url:'not-url'},{key:''},{key:'key\nheader'}]) assert.throws(()=>parseWorker({...base,...patch}))
})
