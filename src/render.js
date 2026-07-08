import ejs from 'ejs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const viewsDir = path.join(__dirname, 'views');

/**
 * Render an EJS template and set it as the response body.
 * @param {object} ctx - Koa context
 * @param {string} template - Template name (without .ejs extension)
 * @param {object} data - Data to pass to the template
 */
export async function render(ctx, template, data = {}) {
  const filePath = path.join(viewsDir, `${template}.ejs`);
  ctx.body = await ejs.renderFile(filePath, data);
  ctx.type = 'text/html';
}
