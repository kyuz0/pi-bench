const { createApp, ref, computed, onMounted } = Vue;

const App = {
    setup() {
        const data = ref(null);
        const loading = ref(true);
        const error = ref(null);
        const searchQuery = ref('');
        const activeModal = ref(null);
        const activeModelModal = ref(null);
        const selectedPlatformIds = ref([]);
        const modelSearchQuery = ref('');

        const fetchData = async () => {
            try {
                const response = await fetch('data.json');
                if (!response.ok) {
                    throw new Error(`HTTP error! status: ${response.status}`);
                }
                const json = await response.json();
                
                json.tasks.sort((a, b) => a.id.localeCompare(b.id));
                data.value = json;


            } catch (e) {
                console.error("Could not load data.json:", e);
                error.value = "Failed to load benchmark data. Ensure data.json exists.";
            } finally {
                loading.value = false;
            }
        };

        onMounted(() => {
            fetchData();
        });

        const getPlatformName = (platformId) => {
            if (!data.value || !data.value.platforms) return platformId;
            const p = data.value.platforms.find(pl => pl.id === platformId);
            return p ? p.name : platformId;
        };

        const filteredModels = computed(() => {
            if (!data.value || !data.value.models) return [];
            let models = data.value.models;
            
            if (selectedPlatformIds.value.length > 0) {
                models = models.filter(m => selectedPlatformIds.value.includes(m.platformId));
            }
            
            if (modelSearchQuery.value) {
                const query = modelSearchQuery.value.toLowerCase();
                models = models.filter(m => {
                    const parsed = parseModelName(m.name);
                    const baseMatch = parsed.base.toLowerCase().includes(query);
                    const quantMatch = parsed.quant ? parsed.quant.toLowerCase().includes(query) : false;
                    const tagMatch = m.tag ? m.tag.toLowerCase().includes(query) : false;
                    return baseMatch || quantMatch || tagMatch;
                });
            }
            return models;
        });

        const togglePlatform = (platformId) => {
            const index = selectedPlatformIds.value.indexOf(platformId);
            if (index === -1) {
                selectedPlatformIds.value.push(platformId);
            } else {
                selectedPlatformIds.value.splice(index, 1);
            }
        };

        const filteredTasks = computed(() => {
            if (!data.value) return [];
            
            // Only return tasks that have at least one result for the active platform
            const validTasks = data.value.tasks.filter(task => {
                return filteredModels.value.some(model => task.results[model.id] !== undefined);
            });

            if (!searchQuery.value) return validTasks;
            
            const lowerQuery = searchQuery.value.toLowerCase();
            return validTasks.filter(task => 
                task.id.toLowerCase().includes(lowerQuery)
            );
        });

        const parseModelName = (idOrName) => {
            let name = idOrName.includes('::') ? idOrName.split('::')[1] : idOrName;
            let clean = name.replace(/_gguf$/i, '');
            clean = clean.replace(/-\d{5}-of-\d{5}$/i, '');
            
            let base = clean;
            let quant = null;

            // Check for custom "-to-" platform quantization format
            const toMatch = clean.match(/(.*?)-to-(.*)$/i);
            if (toMatch) {
                let tempBase = toMatch[1];
                let tempQuant = toMatch[2];
                // Strip common model details like MTP-BF16 before the "-to-" prefix if they exist
                tempBase = tempBase.replace(/-MTP-BF16$/i, '');
                base = tempBase;
                quant = tempQuant.replace(/_/g, '.');
            } else {
                // Check for mixed-precision quants (e.g., Q4KExperts-F16HC-...-imatrix)
                const mixedMatch = clean.match(/^(.*?)-((Q\d+[A-Z]*Experts|Q\d+K[A-Z]*Experts)-.+)$/i);
                if (mixedMatch) {
                    base = mixedMatch[1];
                    quant = mixedMatch[2];
                    // Strip trailing -chat-v2-imatrix or similar suffixes for cleaner display
                    quant = quant.replace(/-chat-v\d+-imatrix$/i, '');
                    quant = quant.replace(/-chat-v\d+$/i, '');
                    quant = quant.replace(/-imatrix$/i, '');
                } else {
                    // Check for hybrid layer quants (e.g., Layers37-42Q4KExperts-...)
                    const layerMatch = clean.match(/(.*?)-(Layers\d.*)$/i);
                    if (layerMatch) {
                        base = layerMatch[1];
                        quant = layerMatch[2];
                    } else {
                        // First check for verbose IQ quants (e.g., IQ2XXS-w2Q2K-AProjQ8...)
                        const iqMatch = clean.match(/(.*?)-(UD-IQ.*|IQ.*)$/i);
                        if (iqMatch) {
                            base = iqMatch[1];
                            quant = iqMatch[2];
                        } else {
                            // Check standard Q or UD-Q quants
                            const match = clean.match(/(.*?)-(UD-Q[A-Z0-9_]+|Q[A-Z0-9_]+)$/i);
                            if (match) {
                                base = match[1];
                                quant = match[2];
                            } else {
                                // Check for common non-GGUF quant formats (AWQ, FP8, GPTQ, EXL2, etc)
                                const otherMatch = clean.match(/(.*?)-((AWQ|FP8|GPTQ|EXL2|FP16|BF16|INT8|INT4).*)$/i);
                                if (otherMatch) {
                                    base = otherMatch[1];
                                    quant = otherMatch[2];
                                }
                            }
                        }
                    }
                }
            }
            
            // Normalize: replace underscores with dots (e.g. Qwen3_6 -> Qwen3.6)
            base = base.replace(/_/g, '.');
            // Capitalize first letter
            base = base.charAt(0).toUpperCase() + base.slice(1);
            // Insert space between name and version if missing (e.g. Qwen3.6 -> Qwen 3.6)
            base = base.replace(/^([a-zA-Z]+)(\d)/, '$1 $2');

            return {
                base: base,
                quant: quant
            };
        };

        const formatDuration = (ms) => {
            if (!ms) return 'N/A';
            const totalSeconds = Math.floor(ms / 1000);
            const minutes = Math.floor(totalSeconds / 60);
            const seconds = totalSeconds % 60;
            return `${minutes}m ${seconds}s`;
        };

        const getPlatformRam = (platformId) => {
            if (!data.value || !data.value.platforms) return null;
            const p = data.value.platforms.find(pl => pl.id === platformId);
            return p ? p.ram : null;
        };

        const getScoreClass = (rate) => {
            if (rate >= 0.8) return 'high';
            if (rate >= 0.5) return 'med';
            return 'low';
        };

        const openModal = (taskId, modelId, result, tag) => {
            const model = data.value && data.value.models ? data.value.models.find(m => m.id === modelId) : null;
            activeModal.value = { taskId, modelId, result, tag, model };
            document.body.style.overflow = 'hidden'; 
        };

        const closeModal = () => {
            activeModal.value = null;
            document.body.style.overflow = 'auto';
        };

        const openModelModal = (model) => {
            activeModelModal.value = model;
            document.body.style.overflow = 'hidden';
        };

        const closeModelModal = () => {
            activeModelModal.value = null;
            document.body.style.overflow = 'auto';
        };

        const highlightDiff = (diffText) => {
            if (!diffText) return '';
            return diffText.split('\n').map(line => {
                const safeLine = line.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
                if (safeLine.startsWith('+') && !safeLine.startsWith('+++')) {
                    return `<span class="diff-add">${safeLine}</span>`;
                }
                if (safeLine.startsWith('-') && !safeLine.startsWith('---')) {
                    return `<span class="diff-sub">${safeLine}</span>`;
                }
                if (safeLine.startsWith('@@')) {
                    return `<span class="diff-info">${safeLine}</span>`;
                }
                return safeLine;
            }).join('\n');
        };

        const formatDate = (isoString) => {
            if (!isoString) return '';
            return new Date(isoString).toLocaleString();
        };

        return {
            data,
            loading,
            error,
            searchQuery,
            modelSearchQuery,
            selectedPlatformIds,
            filteredModels,
            filteredTasks,
            activeModal,
            activeModelModal,
            parseModelName,
            formatDuration,
            getScoreClass,
            getPlatformRam,
            getPlatformName,
            togglePlatform,
            openModal,
            closeModal,
            openModelModal,
            closeModelModal,
            highlightDiff,
            formatDate
        };
    }
};

createApp(App).mount('#app');
