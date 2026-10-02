import test from 'node:test';
import assert from 'node:assert/strict';
import {buildModelCatalog} from '../src/model-catalog.mjs';
import {modelRegistry} from './fixtures/router-model-registry.mjs';

const legacy="You are Codex, a coding assistant. Follow the user's authorized task and applicable project instructions. Use available tools when needed, subject to sandbox and approval policies. Never claim tool actions or results that did not occur. A request to avoid tools for a connectivity test applies only to that test, not to later tasks.";
test('catalog generation preserves declared metadata without migrating or inheriting instructions',()=>{
 const r={...modelRegistry(),activeProviderId:'one'};
 r.models[0].catalogEntry.base_instructions=legacy;
 const base={models:[{slug:'gpt-6-sol',model_messages:{instructions_template:'Complete native instructions: commentary and all other requirements.',instructions_variables:{personality:'keep'}}}]};
 const before=structuredClone({r,base});
 const out=buildModelCatalog(r,base);
 assert.equal(out.models[1].base_instructions,legacy);
 assert.equal(Object.hasOwn(out.models[1],'model_messages'),false);
 assert.deepEqual(out.models[0],base.models[0]);
 assert.deepEqual({r,base},before);
});
test('explicit custom instructions and templates are not replaced',()=>{
 const r={...modelRegistry(),activeProviderId:'one'};
 Object.assign(r.models[0].catalogEntry,{base_instructions:'User custom instructions',model_messages:{instructions_template:'custom'}});
 const out=buildModelCatalog(r,{models:[{slug:'gpt-6-sol',model_messages:{instructions_template:'native'}}]});
 assert.deepEqual(out.models[1],r.models[0].catalogEntry);
});
test('missing matching template is not borrowed from an unrelated model',()=>{
 const r={...modelRegistry(),activeProviderId:'one'};r.models[0].catalogEntry.base_instructions=legacy;
 const out=buildModelCatalog(r,{models:[{slug:'unrelated',model_messages:{instructions_template:'wrong'}}]});
 assert.equal(out.models[1].base_instructions,legacy);
 assert.equal(Object.hasOwn(out.models[1],'model_messages'),false);
});
