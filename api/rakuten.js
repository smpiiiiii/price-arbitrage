/**
 * 楽天商品検索API クライアント
 *
 * 楽天市場の商品を検索して国内販売価格を取得する。
 * アプリケーションIDだけで利用可能（シンプルな認証）。
 */

const RAKUTEN_API_BASE = 'https://app.rakuten.co.jp/services/api/IchibaItem/Search/20220601';

/**
 * 楽天商品検索APIで商品を検索する
 * @param {string} keyword - 検索キーワード
 * @param {object} options - オプション
 * @param {string} options.appId - 楽天アプリケーションID
 * @param {number} [options.hits=20] - 取得件数（最大30）
 * @param {number} [options.page=1] - ページ番号
 * @param {string} [options.sort] - ソート順
 * @returns {Promise<Array<{title: string, price: number, currency: string, imageUrl: string, url: string, shopName: string, reviewCount: number, reviewAverage: number}>>}
 */
export async function searchRakuten(keyword, options = {}) {
    const { appId, hits = 20, page = 1, sort = '' } = options;

    if (!appId) {
        throw new Error('楽天APIキーが設定されていません');
    }

    const params = new URLSearchParams({
        applicationId: appId,
        keyword: keyword,
        hits: String(Math.min(hits, 30)),
        page: String(page),
        format: 'json',
    });

    if (sort) {
        params.set('sort', sort);
    }

    const url = `${RAKUTEN_API_BASE}?${params}`;

    console.log(`🔍 楽天API検索: "${keyword}"`);

    const res = await fetch(url, {
        signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) {
        const errorText = await res.text();
        throw new Error(`楽天API エラー (${res.status}): ${errorText}`);
    }

    const data = await res.json();
    const items = data.Items || [];

    console.log(`  → 楽天: ${items.length}件取得`);

    return items.map(entry => {
        const item = entry.Item || entry;
        return {
            title: item.itemName || '',
            price: item.itemPrice || 0,
            currency: 'JPY',
            imageUrl: item.mediumImageUrls?.[0]?.imageUrl || item.smallImageUrls?.[0]?.imageUrl || '',
            url: item.itemUrl || '',
            shopName: item.shopName || '',
            reviewCount: item.reviewCount || 0,
            reviewAverage: item.reviewAverage || 0,
            genreId: item.genreId || '',
            availability: item.availability || 1,
        };
    });
}
