# Coon frontend/backend integration

The frontend now supports a separate backend URL using:

```html
<script>window.COON_API_URL = 'https://YOUR-RENDER-SERVICE.onrender.com';</script>
```

Place that before the main app script in `index.html` (or replace the empty default in the existing configuration).

For local development, leave it empty and the app uses `location.origin`.
