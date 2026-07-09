import Koa from 'koa';
import mount from 'koa-mount';

const app = new Koa();
app.proxy = true;

const subApp = new Koa();
subApp.proxy = true;

subApp.use((ctx) => {
  console.log('--- Inside subApp ---');
  console.log('ctx.app.proxy:', ctx.app.proxy);
  console.log('ctx.secure:', ctx.secure);
  console.log('ctx.protocol:', ctx.protocol);
  console.log('x-forwarded-proto:', ctx.get('x-forwarded-proto'));
  ctx.body = 'ok';
});

app.use(mount(subApp));

const req = {
  headers: {
    'x-forwarded-proto': 'https'
  },
  url: '/',
  method: 'GET',
  socket: {}
};

const res = {
  setHeader: () => {},
  end: () => {},
  on: () => {}
};

app.callback()(req, res);
