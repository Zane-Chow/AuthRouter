import ejs from 'ejs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const viewsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'views');

export async function render(ctx, template, data = {}) {
  const filePath = path.join(viewsDir, `${template}.ejs`);
  ctx.body = await ejs.renderFile(filePath, {
    csrfToken: ctx.state.csrfToken || '',
    ...data,
  });
  ctx.type = 'text/html; charset=utf-8';
}
