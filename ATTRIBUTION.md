# Attribution

YT-TLDW is licensed under the GNU General Public License v3.0 (see LICENSE).

## SponsorBlock
Portions of the skip-scheduling approach, the progress-bar preview overlay
(`src/js-components/previewBar.ts`), and the privacy-preserving segment
lookup (SHA-256 videoID prefix → `sponsor.ajay.app/api/skipSegments`) are
adapted from [SponsorBlock](https://github.com/ajayyy/SponsorBlock)
by Ajay Ramachandran and contributors, also GPL-3.0.

- Website / API: https://sponsor.ajay.app
- API docs: https://wiki.sponsor.ajay.app/w/API_Docs
- K-anonymity: https://github.com/ajayyy/SponsorBlock/wiki/K-Anonymity

The public SponsorBlock segment database is contributed by volunteers.
This extension queries that API; it does not redistribute the database.

## Other references used during research (not copied as code)
- Kaset YouTube Ask / YouChat documentation (sozercan/kaset)
- GreasyFork userscripts demonstrating Ask DOM automation patterns
