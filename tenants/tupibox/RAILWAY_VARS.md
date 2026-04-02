# Variables Railway — Servicio tupibox

Agregar estas variables en Railway → proyecto yeppo-whatsapp-webhook → servicio tupibox:

| Variable | Valor |
|----------|-------|
| TUPIBOX_SHEETS_ID | 1BTBNCYROJ5HkgxhGOi8i9Ccn6H2z7P6xykQNdQGlYNA |
| TUPIBOX_SHEETS_CLIENT_EMAIL | openclaw@tupibox-openclaw.iam.gserviceaccount.com |
| TUPIBOX_SHEETS_PRIVATE_KEY | (contenido de .secrets/google-service-account-tupibox.json → campo private_key) |

## Notas

- `TUPIBOX_SHEETS_PRIVATE_KEY`: copiar el valor del campo `"private_key"` del JSON de la service account.
  El valor empieza con `-----BEGIN RSA PRIVATE KEY-----` (o similar). Pegar el contenido completo incluyendo los `\n` literales — Railway los maneja correctamente.
- Las variables usan prefijo `TUPIBOX_` para no conflictuar con las variables de Yeppo (`GOOGLE_SHEETS_*`).
- La service account `openclaw@tupibox-openclaw.iam.gserviceaccount.com` ya tiene acceso de Editor
  al Sheet `1BTBNCYROJ5HkgxhGOi8i9Ccn6H2z7P6xykQNdQGlYNA`.
