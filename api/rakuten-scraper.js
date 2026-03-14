/**
 * 楽天 HTTPスクレイパー（修正版）
 *
 * APIキー不要。楽天市場の検索結果ページから
 * JSON-LDの構造化データを優先的に抽出する。
 */

import * as cheerio from 'cheerio';

/**
 * 楽天市場の検索結果をスクレイピングする
 * @param {string} keyword - 検索キーワード
 * @param {object} [options] - オプション
 * @param {number} [options.page=1] - ページ番号
 * @returns {Promise<Array>}
 */
export async function scrapeRakuten(keyword, options = {}) {
    const { page = 1 } = options;

    const encodedKeyword = encodeURIComponent(keyword);
    const url = `https://search.rakuten.co.jp/search/mall/${encodedKeyword}/?p=${page}`;

    console.log(`🌐 楽天 HTTP検索: "${keyword}"`);

    try {
        const res = await fetch(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Accept-Language': 'ja,en-US;q=0.9,en;q=0.8',
                'Cache-Control': 'no-cache',
            },
            signal: AbortSignal.timeout(15000),
        });

        if (!res.ok) {
            console.error(`⚠️ 楽天 HTTPエラー: ${res.status}`);
            return [];
        }

        const html = await res.text();
        const $ = cheerio.load(html);
        let items = [];

        // 方法1: JSON-LD（最も信頼性が高い）
        items = extractFromJsonLd($);
        if (items.length > 0) {
            console.log(`  → 楽天 JSON-LD: ${items.length}件取得`);
            return items;
        }

        // 方法2: セレクタベースのパース
        items = extractFromSearchResults($);
        if (items.length > 0) {
            console.log(`  → 楽天 HTML: ${items.length}件取得`);
            return items;
        }

        // 方法3: リンク+価格パターンマッチ
        items = extractByLinks($);
        console.log(`  → 楽天 リンク: ${items.length}件取得`);
        return items;

    } catch (err) {
        console.error(`⚠️ 楽天 HTTPスクレイピングエラー: ${err.message}`);
        return [];
    }
}

/**
 * JSON-LDから商品を抽出する（最も信頼性が高い）
 * 楽天は検索結果にItemListのJSON-LDを埋め込んでいる
 */
function extractFromJsonLd($) {
    const items = [];

    $('script[type="application/ld+json"]').each((i, el) => {
        try {
            const data = JSON.parse($(el).html());

            // ItemList形式（楽天検索結果ページ）
            if (data['@type'] === 'ItemList' && data.itemListElement) {
                for (const listItem of data.itemListElement) {
                    const product = listItem.item || listItem;
                    if (product['@type'] !== 'Product') continue;

                    const offer = Array.isArray(product.offers) ? product.offers[0] : product.offers;
                    if (!offer) continue;

                    const price = parseFloat(offer.price || offer.lowPrice || '0');
                    if (price <= 0) continue;

                    // 画像URL処理
                    let imageUrl = '';
                    if (Array.isArray(product.image)) {
                        imageUrl = product.image[0] || '';
                    } else if (typeof product.image === 'string') {
                        imageUrl = product.image;
                    }

                    items.push({
                        title: product.name || '',
                        price,
                        currency: offer.priceCurrency || 'JPY',
                        imageUrl,
                        url: offer.url || product.url || '',
                        shopName: offer.seller?.name || '',
                        reviewCount: 0,
                        reviewAverage: 0,
                    });
                }
            }
        } catch {
            // JSONパースエラーは無視
        }
    });

    return items;
}

/**
 * 楽天の検索結果カードからHTML要素ベースで抽出
 */
function extractFromSearchResults($) {
    const items = [];

    // 楽天の検索結果カードはclass名がハッシュ化されているが
    // .searchresultitem は安定して存在する
    $('.searchresultitem').each((i, el) => {
        try {
            const $card = $(el);

            // タイトル: title-link クラスを含むaタグのテキスト
            const $titleLink = $card.find('a[class*="title-link"]').first();
            let title = $titleLink.text().trim();
            if (!title) {
                // フォールバック: 最初の商品リンクのテキスト
                title = $card.find('a[href*="item.rakuten.co.jp"]').filter((_, a) => {
                    const text = $(a).text().trim();
                    return text.length > 10; // 短すぎるテキストを除外
                }).first().text().trim();
            }
            if (!title || title.length < 5) return;

            // URL
            const url = $titleLink.attr('href') ||
                $card.find('a[href*="item.rakuten.co.jp"]').first().attr('href') || '';

            // 価格: price クラスを含む要素
            let price = 0;
            const priceText = $card.find('[class*="price"]').text();
            const priceMatch = priceText.match(/([\d,]+)\s*円/);
            if (priceMatch) {
                price = parseInt(priceMatch[1].replace(/,/g, ''));
            }
            if (price <= 0) return;

            // 画像
            const imageUrl = $card.find('img[src*="thumbnail"]').attr('src') ||
                $card.find('img[src*="rakuten"]').first().attr('src') || '';

            // ショップ名
            const shopName = $card.find('[class*="merchant"], [class*="shop"]').text().trim() || '';

            items.push({
                title,
                price,
                currency: 'JPY',
                imageUrl,
                url,
                shopName,
                reviewCount: 0,
                reviewAverage: 0,
            });
        } catch {
            // 無視
        }
    });

    return items;
}

/**
 * リンクベースで商品を抽出（最終フォールバック）
 */
function extractByLinks($) {
    const items = [];
    const seenUrls = new Set();

    $('a[href*="item.rakuten.co.jp"]').each((i, el) => {
        if (items.length >= 30) return;

        const $a = $(el);
        const url = $a.attr('href') || '';
        const title = $a.text().trim();

        // 短すぎるテキスト、重複URLを除外
        if (!title || title.length < 10 || seenUrls.has(url)) return;
        seenUrls.add(url);

        // 親要素から価格を探す
        const $parent = $a.closest('.searchresultitem, .dui-card, [class*="item"]');
        if (!$parent.length) return;

        const parentText = $parent.text();
        const priceMatch = parentText.match(/([\d,]+)\s*円/);
        const price = priceMatch ? parseInt(priceMatch[1].replace(/,/g, '')) : 0;

        if (price > 0 && price < 10000000) {
            const imageUrl = $parent.find('img[src*="thumbnail"], img[src*="rakuten"]').first().attr('src') || '';

            items.push({
                title,
                price,
                currency: 'JPY',
                imageUrl,
                url,
                shopName: '',
                reviewCount: 0,
                reviewAverage: 0,
            });
        }
    });

    return items;
}
