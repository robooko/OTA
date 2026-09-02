// The one place that talks to the Google Places API (mirrors resend.js /
// aiReplies.js): controllers import this, never call Google directly.
// Places API (New) v1 place details with a field mask returns the rating,
// total count and up to five most-relevant reviews -- exactly the payload a
// venue website's reviews widget needs, and all Google will give anyone.
const KEY = process.env.GOOGLE_PLACES_API_KEY;

function isConfigured() {
  return Boolean(KEY);
}

// Returns the normalised payload, or null when Google says no (bad place
// id, quota, outage) -- callers decide between stale cache and 502.
async function fetchPlaceReviews(placeId) {
  const res = await fetch(`https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}`, {
    headers: {
      'X-Goog-Api-Key': KEY,
      'X-Goog-FieldMask': 'rating,userRatingCount,googleMapsUri,reviews',
    },
  });
  if (!res.ok) {
    console.error('Google Places fetch failed', res.status, await res.text().catch(() => ''));
    return null;
  }
  const place = await res.json();
  return {
    rating: place.rating ?? null,
    count: place.userRatingCount ?? 0,
    maps_url: place.googleMapsUri ?? null,
    // The "leave us a review" deep link is derived from the place id -- no
    // separate stored URL needed.
    write_review_url: `https://search.google.com/local/writereview?placeid=${encodeURIComponent(placeId)}`,
    reviews: (place.reviews ?? []).map((r) => ({
      author: r.authorAttribution?.displayName ?? 'Google user',
      author_photo: r.authorAttribution?.photoUri ?? null,
      rating: r.rating ?? 5,
      text: r.text?.text ?? r.originalText?.text ?? '',
      relative_time: r.relativePublishTimeDescription ?? '',
      published_at: r.publishTime ?? null,
    })),
  };
}

module.exports = { isConfigured, fetchPlaceReviews };
