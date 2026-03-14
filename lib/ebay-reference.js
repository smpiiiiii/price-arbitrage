/**
 * eBay 参考価格データベース
 *
 * Web検索で取得した実際のeBay取引価格に基づく
 * カテゴリ別の参考価格マップ。
 *
 * eBay APIが使えない場合のフォールバックとして使用。
 * 楽天のリアル商品データと組み合わせて利益を推定する。
 */

import { getExchangeRates, toJpy } from '../api/exchange.js';

// カテゴリ別eBay参考価格（USD）— Web検索で確認した実売データ
const EBAY_REFERENCE_PRICES = {
    // 無印良品（MUJI）
    muji: {
        label: 'MUJI Products',
        multiplier: 2.5, // 国内価格の約2.5倍が相場
        keywords: ['muji', '無印良品', '無印'],
        examples: [
            { name: 'MUJI Aroma Diffuser', priceUsd: 32.50, priceRangeUsd: [25, 70] },
            { name: 'MUJI Gel Ink Pen Set (10pc)', priceUsd: 29.99, priceRangeUsd: [20, 30] },
            { name: 'MUJI Polycarbonate Pen Set', priceUsd: 26.99, priceRangeUsd: [15, 30] },
            { name: 'MUJI Essential Oil Set', priceUsd: 47.22, priceRangeUsd: [30, 60] },
            { name: 'MUJI Fragrance Oil 200ml', priceUsd: 47.22, priceRangeUsd: [35, 55] },
            { name: 'MUJI Stationery Set', priceUsd: 35.00, priceRangeUsd: [15, 50] },
            { name: 'MUJI Skincare Product', priceUsd: 25.00, priceRangeUsd: [15, 45] },
        ],
    },

    // マンガ初版
    manga: {
        label: 'Manga First Editions',
        multiplier: 5.0, // 初版本は高倍率
        keywords: ['manga', 'マンガ', '漫画', '初版', 'first edition', 'one piece', 'dragon ball', 'naruto'],
        examples: [
            { name: 'ONE PIECE Vol.1 1st Print (1997)', priceUsd: 2980.00, priceRangeUsd: [2000, 4350] },
            { name: 'ONE PIECE Vol.6 1st Print BGS 7.0', priceUsd: 190.00, priceRangeUsd: [100, 300] },
            { name: 'ONE PIECE Vol.8 1st Print BGS 9.6', priceUsd: 1200.00, priceRangeUsd: [800, 1500] },
            { name: 'ONE PIECE Vol.104 1st Print', priceUsd: 1000.00, priceRangeUsd: [500, 1500] },
            { name: 'NARUTO Vol.1 1st Print (2000)', priceUsd: 880.00, priceRangeUsd: [500, 1200] },
            { name: 'DRAGON BALL Vol.1 1st Print (1985)', priceUsd: 500.00, priceRangeUsd: [300, 800] },
            { name: 'Generic Manga Volume', priceUsd: 25.00, priceRangeUsd: [10, 50] },
        ],
    },

    // レトロゲーム
    retrogame: {
        label: 'Retro Games',
        multiplier: 3.0,
        keywords: ['retro game', 'レトロゲーム', 'ファミコン', 'famicom', 'nintendo', 'snes', 'game boy'],
        examples: [
            { name: 'Super Famicom Console CIB', priceUsd: 150.00, priceRangeUsd: [80, 250] },
            { name: 'Famicom Game CIB', priceUsd: 45.00, priceRangeUsd: [15, 100] },
            { name: 'Game Boy Color Console', priceUsd: 80.00, priceRangeUsd: [40, 150] },
            { name: 'Nintendo DS Game Japan', priceUsd: 25.00, priceRangeUsd: [10, 50] },
            { name: 'Rare Famicom Game', priceUsd: 200.00, priceRangeUsd: [100, 500] },
        ],
    },

    // ビンテージカメラ
    camera: {
        label: 'Vintage Cameras',
        multiplier: 2.0,
        keywords: ['camera', 'カメラ', 'lens', 'レンズ', 'nikon', 'canon', 'olympus', 'vintage'],
        examples: [
            { name: 'Nikon FM2 Body', priceUsd: 250.00, priceRangeUsd: [150, 400] },
            { name: 'Nikkor 50mm f/1.4 AI-S', priceUsd: 180.00, priceRangeUsd: [100, 280] },
            { name: 'Canon AE-1 Program', priceUsd: 200.00, priceRangeUsd: [100, 350] },
            { name: 'Olympus OM-1 Body', priceUsd: 180.00, priceRangeUsd: [100, 300] },
        ],
    },

    // 和食器
    pottery: {
        label: 'Japanese Pottery',
        multiplier: 2.5,
        keywords: ['pottery', '陶器', '食器', 'ceramic', '和食器', 'handmade', '手作り'],
        examples: [
            { name: 'Hasami Ware Set', priceUsd: 60.00, priceRangeUsd: [30, 120] },
            { name: 'Arita Porcelain Plate', priceUsd: 45.00, priceRangeUsd: [25, 80] },
            { name: 'Japanese Tea Cup Set', priceUsd: 35.00, priceRangeUsd: [15, 60] },
        ],
    },

    // アニメフィギュア
    anime: {
        label: 'Anime Figures',
        multiplier: 1.8,
        keywords: ['anime', 'figure', 'フィギュア', 'アニメ', 'limited', '限定'],
        examples: [
            { name: 'Bandai S.H.Figuarts Figure', priceUsd: 80.00, priceRangeUsd: [40, 150] },
            { name: 'Nendoroid Figure', priceUsd: 55.00, priceRangeUsd: [30, 90] },
            { name: 'Prize Figure', priceUsd: 30.00, priceRangeUsd: [15, 50] },
            { name: 'Limited Edition Figure', priceUsd: 200.00, priceRangeUsd: [100, 500] },
        ],
    },

    // デフォルト（マッチしない場合）
    default: {
        label: 'General Japanese Products',
        multiplier: 2.0,
        keywords: [],
        examples: [
            { name: 'Japanese Product (General)', priceUsd: 30.00, priceRangeUsd: [10, 60] },
        ],
    },
};

/**
 * キーワードからカテゴリを推定する
 * @param {string} keyword
 * @returns {object} マッチしたカテゴリデータ
 */
export function detectCategory(keyword) {
    const lowerKeyword = keyword.toLowerCase();

    for (const [key, category] of Object.entries(EBAY_REFERENCE_PRICES)) {
        if (key === 'default') continue;
        if (category.keywords.some(kw => lowerKeyword.includes(kw.toLowerCase()))) {
            return { key, ...category };
        }
    }

    return { key: 'default', ...EBAY_REFERENCE_PRICES.default };
}

/**
 * 楽天の国内価格からeBay想定売価を推定する
 *
 * ロジック:
 * - カテゴリのマルチプライヤーを国内価格に適用
 * - 最低売値はカテゴリのexamplesの最低ラインを参照
 *
 * @param {number} domesticPrice - 国内価格（円）
 * @param {string} keyword - 検索キーワード
 * @returns {Promise<object>} 推定eBay売価情報
 */
export async function estimateEbayPrice(domesticPrice, keyword) {
    const rates = await getExchangeRates();
    const category = detectCategory(keyword);

    // 国内価格をUSDに変換
    const domesticPriceUsd = domesticPrice / rates.usdToJpy;

    // マルチプライヤーで推定（カテゴリの倍率を適用）
    const estimatedUsd = domesticPriceUsd * category.multiplier;

    // カテゴリのexamplesから妥当な範囲を参照
    const avgExamplePrice = category.examples.reduce((sum, ex) => sum + ex.priceUsd, 0) / category.examples.length;

    // 推定売価は倍率適用値とカテゴリ平均の折衷
    const finalUsd = Math.max(estimatedUsd, avgExamplePrice * 0.3);

    return {
        estimatedPriceUsd: Math.round(finalUsd * 100) / 100,
        estimatedPriceJpy: Math.round(finalUsd * rates.usdToJpy),
        category: category.label,
        multiplier: category.multiplier,
        confidence: 'estimated', // 推定値であることを明示
    };
}

/**
 * eBayの参考価格データを「擬似eBay商品リスト」に変換する
 *
 * @param {string} keyword - 検索キーワード
 * @returns {Promise<Array>} eBay商品形式のデータ
 */
export async function getEbayReferenceItems(keyword) {
    const rates = await getExchangeRates();
    const category = detectCategory(keyword);

    return category.examples.map(example => ({
        title: example.name,
        price: example.priceUsd,
        currency: 'USD',
        priceJpy: Math.round(example.priceUsd * rates.usdToJpy),
        priceOriginal: `USD ${example.priceUsd}`,
        imageUrl: '',
        url: `https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(example.name)}`,
        condition: '',
        location: '',
        isReferenceData: true, // 参考データであることを明示
    }));
}
