/**
 * eBay Browse API クライアント
 *
 * eBay公式のBrowse APIを使って商品を検索する。
 * OAuth2.0 Client Credentials Grantでアクセストークンを取得。
 * スクレイピング不要でクラッシュなし。
 */

// アクセストークンキャッシュ
let tokenCache = { token: '', expiresAt: 0 };

/**
 * eBay OAuth2.0 アクセストークンを取得する
 * @param {string} clientId - eBayアプリのクライアントID
 * @param {string} clientSecret - eBayアプリのクライアントシークレット
 * @returns {Promise<string>} アクセストークン
 */
async function getAccessToken(clientId, clientSecret) {
    // キャッシュが有効ならそのまま返す（5分前に更新）
    if (tokenCache.token && Date.now() < tokenCache.expiresAt - 300000) {
        return tokenCache.token;
    }

    const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

    const res = await fetch('https://api.ebay.com/identity/v1/oauth2/token', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Authorization': `Basic ${credentials}`,
        },
        body: 'grant_type=client_credentials&scope=https://api.ebay.com/oauth/api_scope',
        signal: AbortSignal.timeout(10000),
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

    console.log('🔑 eBay アクセストークン取得成功');
    return tokenCache.token;
}

/**
 * eBay Browse API で商品を検索する
 * @param {string} keyword - 検索キーワード
 * @param {object} options - オプション
 * @param {string} options.clientId - eBay Client ID
 * @param {string} options.clientSecret - eBay Client Secret
 * @param {number} [options.limit=20] - 取得件数（最大200）
 * @param {string} [options.sort] - ソート順
 * @param {string} [options.filter] - フィルタ
 * @returns {Promise<Array<{title: string, price: number, currency: string, imageUrl: string, url: string, condition: string, location: string}>>}
 */
export async function searchEbay(keyword, options = {}) {
    const { clientId, clientSecret, limit = 20, sort = '', filter = '' } = options;

    if (!clientId || !clientSecret) {
        throw new Error('eBay APIキーが設定されていません');
    }

    const token = await getAccessToken(clientId, clientSecret);

    // 検索パラメータ構築
    const params = new URLSearchParams({
        q: keyword,
        limit: String(Math.min(limit, 200)),
    });

    // 日本から出品されている商品やワールドワイドを検索
    if (filter) {
        params.set('filter', filter);
    }

    if (sort) {
        params.set('sort', sort);
    }

    const url = `https://api.ebay.com/buy/browse/v1/item_summary/search?${params}`;

    console.log(`🔍 eBay API検索: "${keyword}"`);

    const res = await fetch(url, {
        headers: {
            'Authorization': `Bearer ${token}`,
            'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US',
            'X-EBAY-C-ENDUSERCTX': 'affiliateCampaignId=<ePNCampaignId>,affiliateReferenceId=<referenceId>',
        },
        signal: AbortSignal.timeout(15000),
    });

    if (!res.ok) {
        const errorText = await res.text();
        throw new Error(`eBay API エラー (${res.status}): ${errorText}`);
    }

    const data = await res.json();
    const items = data.itemSummaries || [];

    console.log(`  → eBay: ${items.length}件取得`);

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
