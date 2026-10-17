// Google Sheets leads sync — pure helpers only (URL/column parsing, row building); the Google
// and NocoDB calls themselves need live credentials.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gsheetParseUrl, gsheetParseCols, gsheetBuildRows } from './worker.js';

test('gsheetParseUrl extracts spreadsheet id and gid', ()=>{
  assert.deepEqual(gsheetParseUrl('https://docs.google.com/spreadsheets/d/18F2lk287frMCOF9XuK6lI-iBoN-Sv9wXLNniUZ8Rde8/edit?gid=0#gid=0'),
    {spreadsheetId:'18F2lk287frMCOF9XuK6lI-iBoN-Sv9wXLNniUZ8Rde8', gid:0});
  assert.deepEqual(gsheetParseUrl('https://docs.google.com/spreadsheets/d/abc_123/edit'), {spreadsheetId:'abc_123', gid:null});
  assert.equal(gsheetParseUrl('https://example.com/x'), null);
});

test('gsheetParseCols accepts JSON or arrays, drops unknown columns, falls back to defaults', ()=>{
  assert.deepEqual(gsheetParseCols('["Phone","Name","Bogus","Phone"]'), ['Phone','Name']);
  assert.deepEqual(gsheetParseCols(['Stage','QualAnswers']), ['Stage','QualAnswers']);
  assert.deepEqual(gsheetParseCols('not json'), ['Phone','Name','Stage','Score','Date']);
  assert.deepEqual(gsheetParseCols(null), ['Phone','Name','Stage','Score','Date']);
});

test('gsheetBuildRows writes a labelled header then one row per lead', ()=>{
  const rows=gsheetBuildRows([{Phone:'+911', Name:'A', LastMsgAt:null, Score:7}, {Phone:'+912', QualAnswers:{city:'Kochi'}}], ['Phone','Name','LastMsgAt','Score','QualAnswers']);
  assert.deepEqual(rows, [
    ['Phone','Name','Last Message','Score','Qual Answers'],
    ['+911','A','','7',''],
    ['+912','','','','{"city":"Kochi"}']
  ]);
});
