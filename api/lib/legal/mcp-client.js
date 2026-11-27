// api/lib/legal/mcp-client.js
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { StreamableHTTPClientTransport } = require("@modelcontextprotocol/sdk/client/streamableHttp.js");

async function buscarLeisRelevantes(textoClausula) {
    const MCP_URL = process.env.LEIS_MCP_URL;
    const MCP_API_KEY = process.env.LEIS_API_KEY;

    if (!MCP_URL || !MCP_API_KEY) {
        console.warn("⚠️ Chaves do MCP de Leis não configuradas.");
        return [];
    }

    // Cria o transporte HTTP com a URL e a chave de segurança (Bearer Token)
    const transport = new StreamableHTTPClientTransport(
        new URL(MCP_URL),
        {
            requestInit: {
                headers: {
                    'Authorization': `Bearer ${MCP_API_KEY}`
                }
            }
        }
    );

    // Cria o cliente MCP
    const client = new Client(
        { name: "macrus-backend", version: "1.0.0" },
        { capabilities: {} }
    );

    try {
        // Conecta (faz o handshake initialize)
        await client.connect(transport);
        
        // Chama a ferramenta de busca
        const result = await client.callTool({
            name: "buscar_texto",
            arguments: {
                consulta: textoClausula,
                limite: 3
            }
        });

        // Desconecta para liberar a sessão
        await client.close();

        // O SDK já retorna o conteúdo formatado em result.content
        return result.content || [];
    } catch (error) {
        console.error("❌ Erro ao buscar leis no MCP via SDK:", error.message);
        return [];
    }
}

module.exports = { buscarLeisRelevantes };
