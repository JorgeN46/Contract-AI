// api/lib/legal/mcp-client.js

async function buscarLeisRelevantes(textoClausula) {
    const MCP_URL = process.env.LEIS_MCP_URL;
    const MCP_API_KEY = process.env.LEIS_API_KEY;

    if (!MCP_URL || !MCP_API_KEY) {
        console.warn("⚠️ Chaves do MCP de Leis não configuradas.");
        return [];
    }

    try {
        // Faz a chamada HTTP para o servidor no Railway
        const response = await fetch(`${MCP_URL}/mcp`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${MCP_API_KEY}` // A trava de segurança
            },
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: 1,
                method: 'tools/call',
                params: {
                    name: 'buscar_texto', // Nome da ferramenta do leis-mcp
                    arguments: {
                        consulta: textoClausula,
                        limite: 3 // Traz os 3 artigos mais relevantes
                    }
                }
            })
        });

        if (!response.ok) {
            throw new Error(`Erro HTTP: ${response.status}`);
        }

        const data = await response.json();
        return data.result?.content || [];
    } catch (error) {
        console.error("❌ Erro ao buscar leis no MCP:", error.message);
        return []; // Se falhar, o chat continua sem as leis
    }
}

module.exports = { buscarLeisRelevantes };
