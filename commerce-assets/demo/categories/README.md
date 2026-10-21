# Category artwork

32 images generated with the built-in ImageGen tool: one square icon and one 3:1 category-page banner for each of the eight grocery and eight jewelry categories.

Exact generation prompts and file mapping are in `manifest.json`. Open `index.html` to review the complete gallery. PNG originals are preserved here; the source generations are retained in the local ImageGen output folder.

To attach artwork to the local stores through the normal admin media and category-attribute APIs:

```sh
python3 commerce-assets/demo/seed-category-images.py --store grocery --apply
python3 commerce-assets/demo/seed-category-images.py --store jewelry --apply
```

Omit `--apply` to preview. The script preserves unrelated attributes, records previous values and uploaded media IDs under `.local`, and verifies the resulting public category image IDs. Images remain editable in Admin → Categories → Category attributes.
