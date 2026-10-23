# FAST SHOP 24H — Bot WhatsApp
Responde clientes (menu 1–5: pacotes, como pagar, estado dos pedidos, confirmar pagamento, suporte) e envia avisos automáticos: pedido recebido, pago, enviado, entregue, cancelado.
1. Supabase › SQL Editor: executar whatsapp-bot.sql (enviado à parte).
2. Publicar (Render grátis, Railway, VPS ou Termux): `npm install && npm start` com as variáveis de .env.example.
3. Abrir o painel (/?senha=...) › Gerar código › no WhatsApp do bot: Dispositivos ligados › Ligar com número de telefone.
A sessão fica guardada no Supabase (tabela wa_auth), por isso sobrevive a reinícios.
