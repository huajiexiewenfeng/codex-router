import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

// Artifact check, run after building; override to check an installed EXE.
test('Windows desktop artifact uses GUI subsystem even in debug builds',async()=>{
 const path=process.env.ROUTER_DESKTOP_EXE??new URL('../src-tauri/target/debug/codex-router-desktop.exe',import.meta.url);
 const bytes=await readFile(path);
 assert.equal(bytes.readUInt16LE(0),0x5a4d,'DOS signature');
 const pe=bytes.readUInt32LE(0x3c);
 assert.equal(bytes.readUInt32LE(pe),0x4550,'PE signature');
 assert.ok([0x10b,0x20b].includes(bytes.readUInt16LE(pe+24)),'PE32/PE32+ optional header');
 assert.equal(bytes.readUInt16LE(pe+24+68),2,'Desktop must use Windows GUI subsystem, not console');
});
