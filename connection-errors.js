// Return only controlled messages; connector errors may contain request credentials.
function classifyConnectionError(error) {
    const errors = [];
    const visit = (err, depth = 0) => {
        if (!err || depth > 5 || errors.includes(err)) return;
        errors.push(err);
        visit(err.cause, depth + 1);
        visit(err.config?.requestErr, depth + 1);
        for (const child of err.config?.requestErrs || []) visit(child, depth + 1);
    };
    visit(error);
    const matches = pattern => errors.some(err => pattern.test(`${err.name || ''} ${err.constructor?.name || ''} ${err.message || ''} ${err.code || ''}`));
    const status = value => errors.some(err => Number(err.statusCode || err.response?.statusCode || err.response?.status) === value);
    if (matches(/UserOfflineError/)) return { code: 'USER_OFFLINE', message: 'TikTok indica que esta cuenta no está en LIVE.' };
    if (matches(/InvalidUniqueIdError/)) return { code: 'INVALID_USERNAME', message: 'TikTok no reconoce el nombre de usuario. Revísalo e inténtalo de nuevo.' };
    if (status(429) || matches(/SignatureRateLimitError/)) return { code: 'RATE_LIMITED', message: 'TikTok o el servicio de firma limitó las solicitudes. Espera antes de reintentar.' };
    if (status(401) || status(403)) return { code: 'UPSTREAM_ACCESS_DENIED', message: 'TikTok o el servicio de firma rechazó el acceso del servidor (401/403). Esto no confirma que la cuenta esté fuera de LIVE.' };
    if (matches(/SignAPIError|SignatureMissingTokensError|PremiumFeatureError|AuthenticatedWebSocketConnectionError/)) return { code: 'SIGN_SERVICE_ERROR', message: 'El servicio de firma del conector no pudo autorizar la conexión. Revisa su configuración en el servidor de Render.' };
    if (matches(/ConnectTimeoutError|ETIMEDOUT|ECONNRESET|ENOTFOUND|EAI_AGAIN|ECONNREFUSED/)) return { code: 'UPSTREAM_NETWORK_ERROR', message: 'El servidor no pudo comunicarse con TikTok o con el servicio de firma. Reintenta en unos momentos.' };
    return { code: 'CONNECTOR_ERROR', message: 'El conector no pudo abrir el LIVE. Revisa la versión del backend y los registros de Render; no se confirmó un error 403.' };
}
module.exports = { classifyConnectionError };
