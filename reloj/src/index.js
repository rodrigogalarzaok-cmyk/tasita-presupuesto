// Reloj de Tasita. Una sola tarea: cada minuto pedirle a tasita-api que revise
// con Mercado Pago. La API decide si hace falta (como mucho una vez por minuto).
import { DurableObject } from 'cloudflare:workers';

const CADA_MS = 60 * 1000;

export class Reloj extends DurableObject {
  // Deja el despertador puesto si no lo está. Se puede llamar cuantas veces sea.
  async asegurar() {
    const puesto = await this.ctx.storage.getAlarm();
    if (!puesto) await this.ctx.storage.setAlarm(Date.now() + 5000);
    return { puesto: puesto || 'recién puesto' };
  }

  async alarm() {
    // Primero se reprograma: si la revisión falla, el reloj no se detiene.
    await this.ctx.storage.setAlarm(Date.now() + CADA_MS);
    await this.ctx.storage.put('ultimo', new Date().toISOString());
    try {
      const r = await this.env.API.fetch('https://tasita-api/revisar');
      await this.ctx.storage.put('estado', r.status);
    } catch (e) {
      await this.ctx.storage.put('estado', String(e));
    }
  }

  async info() {
    return {
      despertador: await this.ctx.storage.getAlarm(),
      ultimo: await this.ctx.storage.get('ultimo'),
      estado: await this.ctx.storage.get('estado')
    };
  }
}

const reloj = (env) => env.RELOJ.get(env.RELOJ.idFromName('unico'));

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(reloj(env).asegurar());
  },
  async fetch(request, env) {
    const r = reloj(env);
    await r.asegurar();
    return Response.json(await r.info());
  }
};
