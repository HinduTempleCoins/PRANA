// NftCard — one NFT tile: image (from metadata), name, tokenId, collection.
// Pure presentational; takes a canonical holding from lib/nft-inventory.mjs.
import { truncateAddress } from '../../lib/format.js';

// Resolve an ipfs:// image to a public gateway for <img>; pass through http/data.
function resolveImage(src) {
  if (typeof src !== 'string' || src.length === 0) return null;
  if (src.startsWith('ipfs://')) {
    return 'https://ipfs.io/ipfs/' + src.slice('ipfs://'.length).replace(/^ipfs\//, '');
  }
  return src;
}

export default function NftCard({ holding }) {
  const meta = holding.metadata || {};
  const img = resolveImage(meta.image || meta.image_url || meta.imageUrl);
  const title = meta.name || holding.name || `#${holding.tokenId}`;
  const collection = holding.name || truncateAddress(holding.contract);
  const isMulti = holding.standard === 'erc1155' && holding.balance > 1n;

  return (
    <div className="nft-card">
      <div className="nft-art" aria-hidden={img ? undefined : true}>
        {img ? (
          // onError hides a broken/unreachable image, falling back to the glow tile.
          <img
            src={img}
            alt={title}
            loading="lazy"
            onError={(e) => {
              e.currentTarget.style.display = 'none';
            }}
          />
        ) : (
          <span className="nft-art-glyph">◈</span>
        )}
        {isMulti && <span className="nft-qty">×{holding.balance.toString()}</span>}
        <span className="nft-standard">{holding.standard === 'erc1155' ? '1155' : '721'}</span>
      </div>
      <div className="nft-meta">
        <div className="nft-title" title={title}>
          {title}
        </div>
        <div className="nft-sub">
          <span className="nft-collection" title={holding.contract}>
            {collection}
          </span>
          <span className="mono nft-id">#{holding.tokenId}</span>
        </div>
      </div>
    </div>
  );
}
