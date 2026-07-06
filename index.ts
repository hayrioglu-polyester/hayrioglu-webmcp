import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import express from "express";
import cors from "cors";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import * as cheerio from "cheerio";

// --- Types ---
interface Product {
  name: string;
  url: string;
  image?: string;
  properties: Record<string, string>;
  categorySlug: string;
}

// --- Scraper Logic ---
let cachedProducts: Product[] | null = null;
let lastFetchTime = 0;
const CACHE_TTL = 1000 * 60 * 60; // 1 hour cache

const CATEGORY_URLS = [
  "kabinler",
  "su-depolari",
  "foseptik-tanklari",
  "silolar",
  "konteynerler",
  "karavan-su-depolari",
  "salamura-tanki",
  "aku-sandigi"
];

const BASE_URL = "https://www.hayrioglupolyester.com.tr/urunlerimiz/";

async function getProducts(): Promise<Product[]> {
  if (cachedProducts && Date.now() - lastFetchTime < CACHE_TTL) {
    return cachedProducts;
  }

  const products: Product[] = [];

  for (const slug of CATEGORY_URLS) {
    try {
      const res = await fetch(`${BASE_URL}${slug}`);
      if (!res.ok) continue;
      const html = await res.text();
      const $ = cheerio.load(html);

      // Extract SEO JSON-LD Scripts (We DO NOT modify the website schemas, just read them)
      $('script[type="application/ld+json"]').each((_, el) => {
        const jsonText = $(el).html();
        if (!jsonText) return;
        try {
          const data = JSON.parse(jsonText);
          const graph = data["@graph"] || [data];
          
          for (const item of graph) {
            if (item["@type"] === "Product") {
              const properties: Record<string, string> = {};
              
              // Extract the precise specs like Kapasite, En, Boy from additionalProperty
              if (item.additionalProperty && Array.isArray(item.additionalProperty)) {
                for (const prop of item.additionalProperty) {
                  if (prop["@type"] === "PropertyValue" && prop.name && prop.value) {
                    properties[prop.name] = prop.value;
                  }
                }
              }

              products.push({
                name: item.name || "Unknown Product",
                url: item.url || "",
                image: item.image,
                properties,
                categorySlug: slug
              });
            }
          }
        } catch (e) {
          // Ignore invalid JSON blocks
        }
      });
    } catch (e) {
      console.error(`Failed to fetch category ${slug}:`, e);
    }
  }

  cachedProducts = products;
  lastFetchTime = Date.now();
  return products;
}

// --- MCP Server ---
const server = new Server(
  {
    name: "hayrioglu-webmcp-universal",
    version: "2.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "search_products",
        description: "Search the structured Hayrioğlu product catalog (Kabinler, Su Depoları, Silolar, vb.) based on text queries or categories.",
        inputSchema: {
          type: "object",
          properties: {
            category: { 
              type: "string", 
              description: "Optional category slug to filter by (e.g., 'kabinler', 'su-depolari', 'foseptik-tanklari')" 
            },
            query: { 
              type: "string", 
              description: "Search term to match against product names or specifications (e.g. '5000 lt', 'Polyester', '200 cm', 'Kare')" 
            },
            max_width: { 
              type: "number", 
              description: "Maximum allowed width/diameter in cm (space constraint)" 
            },
            max_length: { 
              type: "number", 
              description: "Maximum allowed length in cm (space constraint)" 
            },
            max_height: { 
              type: "number", 
              description: "Maximum allowed height in cm (space constraint)" 
            }
          }
        }
      },
      {
        name: "read_website_article",
        description: "Reads the informational text content from a general product category page (like moloz-kuleleri, deniz-bisikletleri) that do not have structured dimensions. Do not use this for water tanks.",
        inputSchema: {
          type: "object",
          properties: {
            category_slug: {
              type: "string",
              description: "The URL slug of the category to read (e.g., moloz-kuleleri, deniz-bisikletleri, cop-konteynerleri, vb.)"
            }
          },
          required: ["category_slug"]
        }
      }
    ]
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name !== "search_products" && request.params.name !== "read_website_article") {
    throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${request.params.name}`);
  }

  const args = request.params.arguments as any;

  if (request.params.name === "read_website_article") {
    const slug = args.category_slug;
    const targetUrl = `${BASE_URL}${slug}`;
    try {
      const res = await fetch(targetUrl);
      if (!res.ok) throw new Error(`Failed to fetch category page: ${res.statusText}`);
      const html = await res.text();
      const $ = cheerio.load(html);
      
      // Remove noisy elements
      $('script, style, nav, header, footer, iframe, .pagination, .items-more').remove();
      
      // Extract text
      let text = $('.category-desc').text().trim();
      if (!text) text = $('.blog-item').text().trim();
      if (!text) text = $('body').text().trim(); // Fallback
      
      text = text.replace(/\s+/g, ' ').trim();
      
      return {
        content: [{ type: "text", text: `Information from ${slug}:\n\n${text}` }]
      };
    } catch (error: any) {
      return {
        isError: true,
        content: [{ type: "text", text: `Failed to fetch article: ${error.message}` }]
      };
    }
  }
  const category = args?.category as string | undefined;
  const query = args?.query as string | undefined;
  const maxWidth = args?.max_width as number | undefined;
  const maxLength = args?.max_length as number | undefined;
  const maxHeight = args?.max_height as number | undefined;

  try {
    const products = await getProducts();
    
    const filteredProducts = products.filter(p => {
      // Filter by category if provided
      if (category && p.categorySlug !== category) return false;
      
      // Filter by query against name or any property values
      if (query) {
        const term = query.toLowerCase();
        let match = p.name.toLowerCase().includes(term);
        if (!match) {
           for (const val of Object.values(p.properties)) {
             if (val.toLowerCase().includes(term)) {
               match = true;
               break;
             }
           }
        }
        if (!match) return false;
      }
      
      // Helper function to extract numeric value from string
      const extractNumber = (val: string | undefined) => {
        if (!val) return NaN;
        // Some properties have numbers like "4,84" or "100"
        return parseFloat(val.replace(',', '.').replace(/[^\d.]/g, ''));
      };

      if (maxWidth !== undefined) {
        const w1 = extractNumber(p.properties["Çap/Genişlik (cm)"]);
        const w2 = extractNumber(p.properties["En (cm)"]);
        const w = !isNaN(w1) ? w1 : (!isNaN(w2) ? w2 : NaN);
        if (!isNaN(w) && w > maxWidth) return false;
      }
      
      if (maxLength !== undefined) {
        const l1 = extractNumber(p.properties["Uzunluk"]);
        const l2 = extractNumber(p.properties["Uzunluk (cm)"]);
        const l3 = extractNumber(p.properties["Boy (cm)"]);
        const l = !isNaN(l1) ? l1 : (!isNaN(l2) ? l2 : (!isNaN(l3) ? l3 : NaN));
        if (!isNaN(l) && l > maxLength) return false;
      }
      
      if (maxHeight !== undefined) {
        const h = extractNumber(p.properties["Yükseklik (cm)"]);
        if (!isNaN(h) && h > maxHeight) return false;
      }
      
      return true;
    });

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(filteredProducts, null, 2)
        }
      ]
    };

  } catch (error: any) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: `Failed to fetch products: ${error.message}`
        }
      ]
    };
  }
});

const app = express();
app.use(cors());

let transport: SSEServerTransport;

app.get("/sse", async (req, res) => {
  // We specify the endpoint where the client will POST its messages
  transport = new SSEServerTransport("/messages", res);
  await server.connect(transport);
  console.log("New SSE connection established");
});

app.post("/messages", async (req, res) => {
  if (transport) {
    await transport.handlePostMessage(req, res);
  } else {
    res.status(500).send("SSE connection not established");
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Hayrioglu Universal WebMCP server listening on port ${PORT}`);
  console.log(`SSE Endpoint: http://localhost:${PORT}/sse`);
});
