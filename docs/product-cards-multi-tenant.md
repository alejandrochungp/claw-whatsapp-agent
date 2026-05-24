# Product Cards Multi-Tenant — Arquitectura

## Estado Actual

**Yeppo**: product cards full vía Shopify Admin API → mapeo handle→variantId → Meta Commerce Manager (`759929732681784`) → WhatsApp interactive product/product_list.
**TupiBox / Softify**: sin product cards (no generan links de producto en respuestas).

## Flujo Actual (Yeppo)

```
1. Bot responde con link yeppo.cl/products/{handle}
2. detectAndSendProductCards() post-procesa la respuesta
3. Mapea handle → variantId (retailer_id de Meta)
   a. Primero busca en productCardsCatalog (memoria, cargado de Shopify)
   b. Si no está → fallback API individual yeppo.cl/products/{handle}.json
4. Envía según plataforma:
   - WhatsApp → interactive.product (single) / interactive.product_list (carrusel)
   - Instagram → sendInstagramImage() + sendInstagramMessage() con precio
   - Messenger → sendMessengerProduct() Generic Template con imagen
```

## Cómo Activar para Otro Tenant

Agregar en el `config.js` del tenant:

```javascript
productCards: {
  enabled: false,
  catalogSource: 'none',  // 'shopify' | 'manual' | 'none'
  
  // Si catalogSource === 'shopify':
  // usa Shopify Admin API (requiere SHOPIFY_TOKEN) → igual que Yeppo
  
  // Si catalogSource === 'manual':
  handleToRetailerId: {
    'producto-ejemplo': '44018000625813',
    // ... mapeo manual handle → variantId/retailer_id de Meta
  },
  
  // Meta Commerce Manager catalog ID
  metaCatalogId: '759929732681784',
  
  // Si no hay catálogo Meta → fallback a link preview (OG tags)
  productInfoFallback: true
}
```

## Sin Shopify Ni Meta Catalog

Alternativas para tenants sin catálogo conectado:
1. **Link preview**: WhatsApp/Messenger generan preview automático de URLs con OG tags
2. **Imagen manual**: el bot puede enviar imagen desde URL fija + caption
3. **No action**: el bot responde con texto y link normal (lo actual en TupiBox/Softify)

## Archivos Relevantes

- `core/server.js` — `detectAndSendProductCards()`, `getProductInfoFromShopify()`, `sendInstagramProductCards()`, `sendMessengerProductCards()`
- `core/meta.js` — `sendWhatsAppProduct()`, `sendWhatsAppProductList()`, `sendInstagramImage()`, `sendInstagramMessage()`, `sendMessengerProduct()`, `getProductInfo()`
- `core/shopify.js` — `getProductCatalog()`, `buildProductCardsMap()`, `getVariantIdFromShopify()`
- `tenants/{tenant}/config.js` — configuración por tenant

## Fecha Documentación
2026-05-23
