const CACHE_NAME = 'macrus-v2'; // Mudamos a versão para forçar o celular a largar o cache antigo

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
  event.respondWith(
    fetch(event.request)
      .then(response => {
        // Se a rede respondeu, atualiza o cache com a versão nova
        if (response && response.status === 200) {
          const responseClone = response.clone();
          caches.open(CACHE_NAME).then(cache => {
            cache.put(event.request, responseClone);
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
