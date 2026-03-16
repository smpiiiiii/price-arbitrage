/**
 * 楽天商品検索API クライアント（新API対応版）
 *
 * 楽天市場の商品を検索して国内販売価格を取得する。
 * 新エンドポイント（openapi.rakuten.co.jp）とaccessKey認証に対応。
 */

const RAKUTEN_API_BASE = 'https://openapi.rakuten.co.jp/ichibams/api/IchibaItem/Search/20220601';

/**
 * 中古品を示すキーワード一覧（タイトルに含まれていたら除外）
 */
const USED_KEYWORDS = [
    '中古', 'ジャンク', '訳あり', 'わけあり', '難あり',
    'リユース', 'セカンドハンド', '再生品', 'リファービッシュ',
    '開封済み', '箱なし', '箱無し', 'used', 'pre-owned',
    'refurbished', 'secondhand', 'second hand',
    'B品', 'アウトレット品', '展示品', '返品',
];

/**
 * 新品のみフィルタ — タイトルに中古関連キーワードが含まれる商品を除外
 * @param {Array} items - 商品リスト
 * @returns {Array} 新品のみの商品リスト
 */
function filterNewOnly(items) {
    return items.filter(item => {
        const title = (item.title || '').toLowerCase();
        return !USED_KEYWORDS.some(kw => title.includes(kw.toLowerCase()));
    });
}

/**
 * 楽天商品検索APIで商品を検索する
 * @param {string} keyword - 検索キーワード
 * @param {object} options - オプション
 * @param {string} options.appId - 楽天アプリケーションID
 * @param {string} [options.accessKey] - 楽天アクセスキー
 * @param {string} [options.affiliateId] - 楽天アフィリエイトID
 * @param {string} [options.referer] - Refererヘッダー（ドメイン認証用）
 * @param {number} [options.hits=20] - 取得件数（最大30）
 * @param {number} [options.page=1] - ページ番号
 * @param {string} [options.sort] - ソート順
 * @returns {Promise<Array<{title: string, price: number, currency: string, imageUrl: string, url: string, shopName: string, reviewCount: number, reviewAverage: number}>>}
 */
export async function searchRakuten(keyword, options = {}) {
    const { appId, accessKey, affiliateId, referer, hits = 20, page = 1, sort = '' } = options;

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

    // アクセスキーがあればクエリパラメータに追加
    if (accessKey) {
        params.set('accessKey', accessKey);
    }

    // アフィリエイトIDがあれば追加
    if (affiliateId) {
        params.set('affiliateId', affiliateId);
    }

    if (sort) {
        params.set('sort', sort);
    }

    // 中古品を除外（新品のみ）
    if (options.usedExcludeFlag) {
        params.set('usedExcludeFlag', '1');
    }

    const url = `${RAKUTEN_API_BASE}?${params}`;

    console.log(`🔍 楽天API検索: "${keyword}"`);

    // リクエストヘッダー（Referer/Origin必須）
    const headers = {
        'User-Agent': 'PriceArbitrage/1.0',
    };
    if (referer) {
        headers['Referer'] = referer;
        // Originも設定（Node.jsのfetchではRefererが無視されることがある）
        try {
            headers['Origin'] = new URL(referer).origin;
        } catch {}
    }

    const res = await fetch(url, {
        headers,
        signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) {
        const errorText = await res.text();
        throw new Error(`楽天API エラー (${res.status}): ${errorText}`);
    }

    const data = await res.json();
    const items = data.Items || [];

    const mapped = items.map(entry => {
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

    // 中古品をタイトルベースで除外
    const filtered = filterNewOnly(mapped);
    const excluded = mapped.length - filtered.length;
    console.log(`  → 楽天: ${mapped.length}件取得${excluded > 0 ? ` → 中古${excluded}件除外 → ${filtered.length}件` : ''}`);

    return filtered;
}
