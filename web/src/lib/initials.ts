/** First letters of the first two words: "UH Pharmacy Courier" is "UP".
 *
 *  Shared, because the sign-in page and the collapsed side rail have to agree.
 *  A project that is a green "UP" circle on the way in and something else once
 *  you are inside is two projects as far as the eye is concerned. */
export const initials = (name: string): string =>
    name.split(/\s+/).filter(Boolean).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
