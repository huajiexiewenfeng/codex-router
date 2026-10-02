// Used by the Router; company mode must be explicitly enabled by its caller.
// The caller owns ingress authentication, thread binding, budgets and fixed URLs.
import { createHash } from 'node:crypto';
const officialHeaders = ['authorization', 'chatgpt-account-id', 'originator', 'user-agent', 'openai-beta', 'content-type', 'accept'];

// Codex represents an incoming cross-thread dispatch as a named output without
// a paired call. Preserve this observed native envelope; do not synthesize an
// association or rewrite it as a different message. Upstream acceptance is
// separate from this local shape check. Ordinary tool outputs still need IDs.
function isNativeDispatchNotice(item) {
  return item.type === 'function_call_output' &&
    item.name === 'send_message_to_thread' && item.namespace === 'codex_app' &&
    typeof item.id === 'string' && item.id.startsWith('fco_') && item.id.length > 4 &&
    typeof item.output === 'string' && !Object.hasOwn(item, 'call_id');
}

// Only the approved empty-summary reasoning shape is eligible. Local rollout
// turn metadata is not model content; it is neither altered nor removed here.
export function companyReasoningFingerprint(item) {
  if (!item || item.type !== 'reasoning' || typeof item.id !== 'string' || !item.id ||
      !Array.isArray(item.summary) || item.summary.length !== 0 ||
      typeof item.encrypted_content !== 'string' || !item.encrypted_content ||
      Object.keys(item).some(key => !['type', 'id', 'summary', 'encrypted_content', 'content', 'internal_chat_message_metadata_passthrough'].includes(key))) return null;
  // Native requests may explicitly serialize an absent content as null or [].
  // Preserve that field; nonempty or otherwise typed content is not approved.
  if (Object.hasOwn(item, 'content') && item.content !== null &&
      !(Array.isArray(item.content) && item.content.length === 0)) return null;
  const metadata = item.internal_chat_message_metadata_passthrough;
  if (metadata != null && (typeof metadata !== 'object' || Array.isArray(metadata) ||
      Object.keys(metadata).some(key => key !== 'turn_id') || typeof metadata.turn_id !== 'string')) return null;
  return createHash('sha256').update(JSON.stringify([item.id, item.summary, item.encrypted_content])).digest('hex');
}

// Diagnostic output is an explicit allowlist: never copy request values, field
// names, IDs, ciphertext, summaries, or hashes into logs.
export function historyDiagnostics(payload, approval, upstreamModel) {
  const candidates = Array.isArray(payload.input) ? payload.input.map((item, index) => ({ item, index }))
    .filter(({ item }) => ['reasoning', 'compaction', 'item_reference'].includes(item?.type) || item?.encrypted_content) : [];
  return {
    hasPreviousResponseId: Boolean(payload.previous_response_id), hasConversation: Boolean(payload.conversation),
    approvalPresent: Boolean(approval), approvalModelMatches: approval?.upstreamModel === upstreamModel,
    candidateCount: candidates.length, truncated: candidates.length > 16,
    items: candidates.slice(0, 16).map(({ item, index }) => ({
      index, type: ['reasoning', 'compaction', 'item_reference'].includes(item.type) ? item.type : 'other',
      idPresent: typeof item.id === 'string' && Boolean(item.id),
      summaryIsArray: Array.isArray(item.summary), summaryEmpty: Array.isArray(item.summary) && item.summary.length === 0,
      encryptedContentPresent: typeof item.encrypted_content === 'string' && Boolean(item.encrypted_content),
      hasContentField: Object.hasOwn(item, 'content'), hasStatusField: Object.hasOwn(item, 'status'),
      hasInternalMetadata: item.internal_chat_message_metadata_passthrough != null,
      hasUnknownFields: Object.keys(item).some(key => !['type', 'id', 'summary', 'encrypted_content', 'internal_chat_message_metadata_passthrough', 'content', 'status'].includes(key)),
      shapeEligible: companyReasoningFingerprint(item) !== null,
      fingerprintMatches: typeof approval?.fingerprint === 'string' &&
        createHash('sha256').update(JSON.stringify([item.id, item.summary, item.encrypted_content])).digest('hex') === approval.fingerprint,
    })),
  };
}

export function textDiagnostics(payload, approval, upstreamModel) {
  const blocked = [];
  if (Array.isArray(payload.input)) payload.input.forEach((item, index) => {
    if (typeof approval?.fingerprint === 'string' && approval.upstreamModel === upstreamModel &&
        companyReasoningFingerprint(item) === approval.fingerprint) return;
    const reasons = [];
    if (item?.type === 'additional_tools') {
      if (item.role !== 'developer') reasons.push('ADDITIONAL_TOOLS_ROLE');
      if (!Array.isArray(item.tools)) reasons.push('ADDITIONAL_TOOLS_ARRAY');
    } else {
      if (!item || (item.type !== undefined && item.type !== 'message')) reasons.push('ITEM_TYPE');
      if (!['user', 'assistant', 'system', 'developer'].includes(item?.role)) reasons.push('MESSAGE_ROLE');
      if (typeof item?.content !== 'string') {
        if (!Array.isArray(item?.content)) reasons.push('MESSAGE_CONTENT');
        else if (item.content.some(part => !part || !['input_text', 'output_text'].includes(part.type) || typeof part.text !== 'string')) reasons.push('CONTENT_PART');
      }
      if (item?.type === 'function_call_output' && (typeof item.call_id !== 'string' || !item.call_id.trim())) reasons.push('MISSING_CALL_ID');
    }
    if (reasons.length) blocked.push({ index, reasons });
  });
  return {
    toolsState: payload.tools === undefined ? 'absent' : !Array.isArray(payload.tools) ? 'not_array' : payload.tools.length ? 'nonempty_array' : 'empty_array',
    inputIsArray: Array.isArray(payload.input), blockedItemCount: blocked.length,
    truncated: blocked.length > 16, items: blocked.slice(0, 16),
  };
}

export function resolveSelection(model, mode = 'legacy', officialModels = []) {
  if (!['legacy', 'self'].includes(mode)) throw new Error('ROUTE_MODE_NOT_ALLOWED');
  if (mode === 'self') {
    if (typeof model === 'string' && !model.endsWith('_self') && officialModels.includes(model)) return { route: 'official', upstreamModel: model };
    if (['gpt-6-sol', 'gpt-6-luna', 'gpt-6-astra'].includes(model)) return { route: 'official', upstreamModel: model };
    // Explicit pilot allowlist; Sol_self and Astra_self are not yet live-verified.
    if (model === 'gpt-6-luna_self') return { route: 'company', upstreamModel: 'gpt-6-luna' };
    if (model === 'gpt-6-sol_self') return { route: 'company', upstreamModel: 'gpt-6-sol' };
    if (model === 'gpt-6-astra_self') return { route: 'company', upstreamModel: 'gpt-6-astra' };
  } else {
    if (model === 'gpt-6-sol') return { route: 'official', upstreamModel: model };
    if (model === 'gpt-6-luna') return { route: 'company', upstreamModel: model };
  }
  throw new Error('MODEL_NOT_ALLOWED');
}

export function prepareRoute(body, incomingHeaders, companyToken, mode = 'legacy', reasoningApproval, toolsApproval, routeOptions = {}) {
  let payload;
  try { payload = JSON.parse(body); } catch { throw new Error('INVALID_REQUEST'); }
  // Only the authenticated native-company caller may supply a captured mapping.
  const selection = routeOptions.companySelection === undefined
    ? resolveSelection(payload?.model, mode, routeOptions.officialModels)
    : mode === 'self' && routeOptions.nativeCompany === true && typeof payload?.model === 'string' && payload.model.endsWith('_self') && routeOptions.companySelection.route === 'company'
      ? routeOptions.companySelection : (() => { throw new Error('MODEL_NOT_ALLOWED'); })();
  if (payload.stream !== true) throw new Error('STREAM_REQUIRED');
  if (selection.route === 'official') {
    if (!/^Bearer \S+$/.test(incomingHeaders.authorization ?? '') || !incomingHeaders['chatgpt-account-id']) throw new Error('OFFICIAL_AUTH_REQUIRED');
    const headers = {};
    for (const key of officialHeaders) if (typeof incomingHeaders[key] === 'string') headers[key] = incomingHeaders[key];
    return { ...selection, body, headers };
  }
  if (typeof companyToken !== 'string' || !/^\S+$/.test(companyToken)) throw new Error('COMPANY_CREDENTIAL_REQUIRED');
  // Explicit task-scoped native forwarding: the gateway validates its own
  // protocol. Preserve all supplied items rather than repairing/dropping them.
  if (routeOptions.nativeCompany === true) {
    if (!Array.isArray(payload.input) || payload.input.some(item => !item || typeof item !== 'object' || Array.isArray(item)) ||
        (payload.tools !== undefined && !Array.isArray(payload.tools))) throw new Error('INVALID_NATIVE_INPUT');
    if (payload.input.some(item => ['function_call', 'function_call_output', 'custom_tool_call', 'custom_tool_call_output'].includes(item.type) &&
        (typeof item.call_id !== 'string' || !item.call_id.trim()) && !isNativeDispatchNotice(item))) throw new Error('MISSING_CALL_ID');
    return { ...selection, body: JSON.stringify({ ...payload, model: selection.upstreamModel }), headers: {
      authorization: `Bearer ${companyToken}`, 'content-type': 'application/json', accept: 'text/event-stream',
    } };
  }
  const approvedReasoning = item => reasoningApproval?.upstreamModel === selection.upstreamModel &&
    typeof reasoningApproval?.fingerprint === 'string' && /^[a-f0-9]{64}$/.test(reasoningApproval.fingerprint) &&
    companyReasoningFingerprint(item) === reasoningApproval.fingerprint;
  if (payload.previous_response_id || payload.conversation || payload.input?.some?.(item =>
      (['reasoning', 'compaction', 'item_reference'].includes(item?.type) || item?.encrypted_content) && !approvedReasoning(item))) {
    throw new Error('HISTORY_NOT_PORTABLE');
  }
  if (Array.isArray(payload.input) && payload.input.some(item => item?.type === 'function_call_output' &&
      (typeof item.call_id !== 'string' || !item.call_id.trim()))) throw new Error('MISSING_CALL_ID');
  const approvedTools = toolsApproval?.upstreamModel === selection.upstreamModel &&
    Array.isArray(payload.tools) && payload.tools.every(tool => tool && typeof tool === 'object' &&
      !Array.isArray(tool) && typeof tool.type === 'string' && Boolean(tool.type.trim()));
  if ((payload.tools !== undefined && (!Array.isArray(payload.tools) || (payload.tools.length && !approvedTools))) ||
      !Array.isArray(payload.input) || payload.input.some(item => {
        if (approvedReasoning(item)) return false;
        // Preserve this native declaration byte-for-byte; upstream support remains unverified.
        if (item?.type === 'additional_tools') return item.role !== 'developer' || !Array.isArray(item.tools);
        return (
        !item || (item.type !== undefined && item.type !== 'message') ||
        !['user', 'assistant', 'system', 'developer'].includes(item.role) ||
        !(typeof item.content === 'string' || (Array.isArray(item.content) && item.content.every(part =>
          part && ['input_text', 'output_text'].includes(part.type) && typeof part.text === 'string'))));
      })) {
    throw new Error('TEXT_PILOT_ONLY');
  }
  // Rewrite only the explicit selection identity, never history or tool records.
  const upstreamBody = selection.upstreamModel === payload.model ? body : JSON.stringify({ ...payload, model: selection.upstreamModel });
  return { ...selection, body: upstreamBody, headers: {
    authorization: `Bearer ${companyToken}`, 'content-type': 'application/json', accept: 'text/event-stream',
  } };
}
