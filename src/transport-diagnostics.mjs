const allowed=new Set(['ECONNRESET','ECONNREFUSED','ETIMEDOUT','ENOTFOUND','EAI_AGAIN','EPIPE',
  'UND_ERR_CONNECT_TIMEOUT','UND_ERR_HEADERS_TIMEOUT','UND_ERR_BODY_TIMEOUT','UND_ERR_SOCKET',
  'UND_ERR_ABORTED','CERT_HAS_EXPIRED','DEPTH_ZERO_SELF_SIGNED_CERT','SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE','ERR_TLS_CERT_ALTNAME_INVALID','ERR_SSL_WRONG_VERSION_NUMBER']);

// Never stringify an error: messages, stack, addresses and certificate fields can contain secrets.
export function safeTransportFailure(error){
  try {
    for(let depth=0;error&&depth<4;depth++,error=error.cause){
      if(typeof error.code==='string'&&allowed.has(error.code))return {networkCode:error.code};
    }
  }catch{/* hostile error values must not change routing or leak details */}
  return {networkCode:'UNKNOWN'};
}
