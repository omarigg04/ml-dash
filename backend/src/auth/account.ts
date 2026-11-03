import axios from 'axios';
import { mlAuth } from './oauth';
import { currentUid } from './context';

// Apodo de la cuenta actual para la interfaz. Caché POR UID; si ML falla se devuelve null (no es crítico).
const TTL_MS = 60 * 60_000;
const nicknames = new Map<string, { nickname: string; exp: number }>();

export const getAccountNickname = async (): Promise<string | null> => {
    const uid = currentUid();
    const hit = nicknames.get(uid);
    if (hit && hit.exp > Date.now()) return hit.nickname;
    try {
        const token = await mlAuth.getToken();
        const r = await axios.get('https://api.mercadolibre.com/users/me', {
            headers: { Authorization: `Bearer ${token}` }, timeout: 5000,
        });
        // Defensa: la respuesta debe ser de la misma cuenta del contexto
        if (String(r.data?.id) !== uid || typeof r.data?.nickname !== 'string') return null;
        nicknames.set(uid, { nickname: r.data.nickname, exp: Date.now() + TTL_MS });
        return r.data.nickname;
    } catch {
        return null;
    }
};
