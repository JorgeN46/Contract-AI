const CACHE_NAME = 'macrus-v2'; 

// Instalação: Ativa o novo Service Worker imediatamente
self.addEventListener('install', event => {
  self.skipWaiting(); 
});

// Ativação: Limpa os caches antigos
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames.map(cacheName => {
          if (cacheName !== CACHE_NAME) {
            return caches.delete(cacheName);
          }
        })
      );
    })
  );
  self.clients.claim();
});

// Estratégia de Rede Primeiro (Network First)
self.addEventListener('fetch', event => {
  // 👇 A TRAVA DE SEGURANÇA AQUI 👇
  const url = new URL(event.request.url);
  
  // Se não for http ou https (ex: chrome-extension://), ignora e sai da função
  if (!url.protocol.startsWith('http')) {
      return;
  }

  // Se for uma requisição de API (POST, etc) ou para o Supabase, não faz cache
  if (event.request.method !== 'GET' || url.href.includes('supabase.co')) {
      return; // Deixa o navegador lidar normalmente
  }
  // 👆 FIM DA TRAVA 👆

  event.respondWith(
    fetch(event.request)
      .then(response => {
        // Se a rede respondeu, atualiza o cache com a versão nova
        if (response && response.status === 200) {
          const responseClone = response.clone();
          caches.open(CACHE_NAME).then(cache => {
            cache.put(event.request, responseClone).catch(err => {
                // Ignora erros de cache silenciosamente para não quebrar o site
            });
          });
        }
        return response;
      })
      .catch(() => {
        // Se a rede falhar (sem internet), usa o cache
        return caches.match(event.request);
      })
  );
});
