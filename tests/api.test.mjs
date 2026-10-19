import test from 'node:test';
import assert from 'node:assert/strict';
import { ArticleApi, SyncError, canonicalFilter, endpointOf, directoryOf, utcDate, safeResponse } from '../.test-build/api.mjs';
const credentials={endpoint:'https://example.invalid',key:'test-key',secret:'test-secret'};
test('only existing read endpoints are called; Key and Secret stay in headers, token-rich list fields are discarded',async()=>{
  const calls=[];
  const api=new ArticleApi(credentials,async(url,headers)=>{calls.push({url,headers});return {status:200,headers:{},json:url.endsWith('/api/subscriptions')?
    {subscriptions:[{fakeid:'p',nickname:'P',is_active:true,access_since:1,rss_url:'secret-url-token'}]}:
    {items:[],next_cursor:'opaque',has_more:false}};});
  assert.deepEqual(await api.subscriptions(),[{fakeid:'p',nickname:'P',is_active:true,access_since:1}]);
  await api.page({fakeids:['p'],directory:'Imported'},'opaque+cursor');
  assert.ok(calls[1].url.includes('order=ingested')&&calls[1].url.includes('body_format=markdown'));
  assert.ok(calls.every(c=>!c.url.includes(credentials.key)&&!c.url.includes(credentials.secret)));
  assert.deepEqual(calls[0].headers,{'X-API-Key':'test-key','X-API-Secret':'test-secret'});
});
test('malformed responses, revoked credentials and rate limits are distinct safe errors',async()=>{
  for(const [status,code] of [[401,'authentication'],[403,'forbidden'],[404,'not_found'],[500,'server']]){
    const api=new ArticleApi(credentials,async()=>({status,headers:{},json:{error:{message:'test-secret'}}}));
    await assert.rejects(api.subscriptions(),e=>e.code===code&&!e.message.includes('test-secret'));
  }
  const limited=new ArticleApi(credentials,async()=>({status:429,headers:{'Retry-After':'30'},json:null}),()=>1000);
  await assert.rejects(limited.subscriptions(),e=>e.code==='rate_limit'&&e.retryAt===31000);
  const broken=new ArticleApi(credentials,async()=>({status:200,headers:{},json:{items:[],next_cursor:null,has_more:false}}));
  await assert.rejects(broken.page({fakeids:['p'],directory:'I'},null),e=>e.code==='response');
  const network=new ArticleApi(credentials,async()=>{throw new Error('test-secret');});
  await assert.rejects(network.subscriptions(),e=>e.code==='network'&&!e.message.includes('test-secret'));
});
test('path traversal, hidden Vault paths and credential-bearing endpoint URLs are rejected',()=>{
  for(const path of ['../outside','/absolute','.obsidian','notes/../other','C:\\outside','notes//other']) assert.throws(()=>directoryOf(path),SyncError);
  for(const url of ['http://example.invalid','https://user:password@example.invalid','https://example.invalid/path','https://example.invalid/?key=secret'])assert.throws(()=>endpointOf(url),SyncError);
  assert.deepEqual(canonicalFilter({fakeids:['b','a','a'],directory:'notes'}).fakeids,['a','b']);
});
test('HTML authentication and rate-limit responses preserve status without parsing JSON',async()=>{
  for(const [status,code] of [[401,'authentication'],[429,'rate_limit'],[503,'server']]){
    const api=new ArticleApi(credentials,async()=>safeResponse({status,headers:{'retry-after':'30'},get json(){throw new Error('HTML');}}));
    await assert.rejects(api.subscriptions(),error=>error.code===code);
  }
  assert.throws(()=>safeResponse({status:200,headers:{},get json(){throw new Error('HTML');}}),error=>error.code==='response');
});
test('date boundaries are explicit UTC and impossible calendar dates are rejected',()=>{
  for(const date of ['2026-02-31','2026-02-29','2026-04-31','2026-13-01','2026-1-01','garbage'])assert.throws(()=>utcDate(date),SyncError);
  assert.equal(utcDate('2024-02-29'),Date.UTC(2024,1,29)/1000);
  assert.equal(utcDate('2026-10-19'),Date.UTC(2026,9,19)/1000);
  assert.equal(utcDate(''),undefined);
});
