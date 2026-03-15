/**
 * eBay Browse API プロキシ — Cloudflare Worker
 *
 * GitHub Pages（フロントエンド）からのリクエストを受け取り、
 * eBay Browse APIへプロキシする。
 * OAuthトークン取得もWorker内で行うため、APIキーが公開されない。
 *
 * === デプロイ手順 ===
 * 1. https://dash.cloudflare.com/ でアカウント作成（無料）
 * 2. Workers & Pages → Create Worker
 * 3. このコードを貼り付けてデプロイ
 * 4. Settings → Variables で以下を設定（暗号化推奨）：
 *    - EBAY_CLIENT_ID: eBay App ID
 *    - EBAY_CLIENT_SECRET: eBay Cert ID
 *    - EBAY_ENV: 'sandbox' or 'production'（デフォルト: production）
 */

// 許可するオリジン（GitHub PagesのURL）
const ALLOWED_ORIGINS = [
    'https://smpiiiiii.github.io',
    'http://localhost:3000',
    'http://localhost:8000',
    'http://127.0.0.1:8000',
];

// トークンキャッシュ（Workerインスタンス内で保持）
let tokenCache = { token: '', expiresAt: 0 };

/**
 * CORSヘッダーを付与する
 */
function corsHeaders(request) {
    const origin = request.headers.get('Origin') || '';
    const allowed = ALLOWED_ORIGINS.find(o => origin.startsWith(o)) || ALLOWED_ORIGINS[0];
    return {
        'Access-Control-Allow-Origin': allowed,
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Max-Age': '86400',
    };
}

/**
 * eBay APIのベースURL（環境切り替え）
 */
function getEbayBaseUrl(env) {
    const isSandbox = (env.EBAY_ENV || 'production') === 'sandbox';
    return isSandbox
        ? 'https://api.sandbox.ebay.com'
        : 'https://api.ebay.com';
}

/**
 * OAuthアクセストークンを取得する
 */
async function getAccessToken(env) {
    // キャッシュが有効なら再利用（5分前に更新）
    if (tokenCache.token && Date.now() < tokenCache.expiresAt - 300000) {
        return tokenCache.token;
    }

    const clientId = env.EBAY_CLIENT_ID;
    const clientSecret = env.EBAY_CLIENT_SECRET;

    if (!clientId || !clientSecret) {
        throw new Error('eBay APIキーが設定されていません。WorkerのEnvironment Variablesを確認してください。');
    }

    const credentials = btoa(`${clientId}:${clientSecret}`);
    const baseUrl = getEbayBaseUrl(env);

    const res = await fetch(`${baseUrl}/identity/v1/oauth2/token`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Authorization': `Basic ${credentials}`,
        },
        body: 'grant_type=client_credentials&scope=https://api.ebay.com/oauth/api_scope',
    });

    if (!res.ok) {
        const errorText = await res.text();
        throw new Error(`eBay OAuth エラー (${res.status}): ${errorText}`);
    }

    const data = await res.json();
    tokenCache = {
        token: data.access_token,
        expiresAt: Date.now() + (data.expires_in * 1000),
    };

    return tokenCache.token;
}

/**
 * eBay Browse API で商品検索する
 */
async function searchEbay(keyword, env, options = {}) {
    const token = await getAccessToken(env);
    const baseUrl = getEbayBaseUrl(env);
    const { limit = 20, sort = '', filter = '' } = options;

    const params = new URLSearchParams({
        q: keyword,
        limit: String(Math.min(limit, 200)),
    });

    if (filter) params.set('filter', filter);
    if (sort) params.set('sort', sort);

    const url = `${baseUrl}/buy/browse/v1/item_summary/search?${params}`;

    let res = await fetch(url, {
        headers: {
            'Authorization': `Bearer ${token}`,
            'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US',
        },
    });

    // 401なら再取得
    if (res.status === 401) {
        tokenCache = { token: '', expiresAt: 0 };
        const newToken = await getAccessToken(env);
        res = await fetch(url, {
            headers: {
                'Authorization': `Bearer ${newToken}`,
                'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US',
            },
        });
    }

    if (!res.ok) {
        const errorText = await res.text();
        throw new Error(`eBay API エラー (${res.status}): ${errorText}`);
    }

    const data = await res.json();
    const items = data.itemSummaries || [];

    return items.map(item => ({
        title: item.title || '',
        price: parseFloat(item.price?.value || '0'),
        currency: item.price?.currency || 'USD',
        imageUrl: item.image?.imageUrl || item.thumbnailImages?.[0]?.imageUrl || '',
        url: item.itemWebUrl || '',
        condition: item.condition || '',
        location: item.itemLocation?.country || '',
        seller: item.seller?.username || '',
        shippingCost: item.shippingOptions?.[0]?.shippingCost?.value
            ? parseFloat(item.shippingOptions[0].shippingCost.value)
            : null,
        shippingCurrency: item.shippingOptions?.[0]?.shippingCost?.currency || 'USD',
    }));
}

/**
 * メインハンドラー
 */
export default {
    async fetch(request, env) {
        // CORSプリフライト
        if (request.method === 'OPTIONS') {
            return new Response(null, { status: 204, headers: corsHeaders(request) });
        }

        const url = new URL(request.url);

        // ============================================================
        //  GET /search?q=keyword&limit=20
        // ============================================================
        if (url.pathname === '/search' || url.pathname === '/api/search') {
            const keyword = url.searchParams.get('q');
            if (!keyword) {
                return new Response(
                    JSON.stringify({ error: 'キーワードを指定してください（?q=keyword）' }),
                    { status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders(request) } }
                );
            }

            try {
                const limit = parseInt(url.searchParams.get('limit') || '20');
                const sort = url.searchParams.get('sort') || '';
                const filter = url.searchParams.get('filter') || '';

                const items = await searchEbay(keyword, env, { limit, sort, filter });

                return new Response(
                    JSON.stringify({
                        keyword,
                        count: items.length,
                        items,
                        source: 'ebay-api',
                        env: env.EBAY_ENV || 'production',
                        searchedAt: new Date().toISOString(),
                    }),
                    { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders(request) } }
                );
            } catch (err) {
                return new Response(
                    JSON.stringify({ error: err.message }),
                    { status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders(request) } }
                );
            }
        }

        // ============================================================
        //  GET /status — ヘルスチェック
        // ============================================================
        if (url.pathname === '/status' || url.pathname === '/api/status') {
            const hasKeys = !!(env.EBAY_CLIENT_ID && env.EBAY_CLIENT_SECRET);
            return new Response(
                JSON.stringify({
                    status: 'ok',
                    hasEbayKeys: hasKeys,
                    environment: env.EBAY_ENV || 'production',
                    version: '1.0.0',
                }),
                { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders(request) } }
            );
        }

        // ============================================================
        //  その他 → 404
        // ============================================================
        return new Response(
            JSON.stringify({
                error: 'Not found',
                endpoints: [
                    'GET /search?q=keyword — eBay商品検索',
                    'GET /status — ステータス確認',
                ],
            }),
            { status: 404, headers: { 'Content-Type': 'application/json', ...corsHeaders(request) } }
        );
    },
};
