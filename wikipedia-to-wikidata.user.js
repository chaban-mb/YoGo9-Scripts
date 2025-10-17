// ==UserScript==
// @name          MusicBrainz Wikipedia to Wikidata Converter
// @namespace     https://github.com/YoGo9
// @version       2025.5.25
// @description   Convert Wikipedia links to their equivalent Wikidata entities, update relationship types. Automatically submits edits when successful or when Wikipedia relationships are removed due to conversion failure. Also makes edits votable and prevents processing with pending edits.
// @author        YoGo9, chaban
// @license       MIT
// @include       *://*.musicbrainz.org/artist/*
// @include       *://*.musicbrainz.org/event/*
// @include       *://*.musicbrainz.org/label/*
// @include       *://*.musicbrainz.org/place/*
// @include       *://*.musicbrainz.org/release-group/*
// @include       *://*.musicbrainz.org/series/*
// @include       *://*.musicbrainz.org/url/*/edit*
// @include       *://*.musicbrainz.org/dialog*
// @grant         GM_xmlhttpRequest
// @connect       wikipedia.org
// @connect       wikidata.org
// @connect       musicbrainz.org
// @tag           ai-created
// ==/UserScript==

(function () {
    'use strict';

    // Adapted from https://stackoverflow.com/a/46012210
    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;

    /**
     * Sets the value of an input element which has been manipulated by React.
     * @param {HTMLInputElement} input
     * @param {string} value
     */
    function setReactInputValue(input, value) {
        nativeInputValueSetter.call(input, value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
    }

    const nativeTextareaValueSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;

    /**
     * Sets the value of a textarea input element which has been manipulated by React.
     * @param {HTMLTextAreaElement} input
     * @param {string} value
     */
    function setReactTextareaValue(input, value) {
        nativeTextareaValueSetter.call(input, value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
    }

    /**
     * Returns the first element that is a descendant of node that matches selectors.
     * @param {string} selectors
     * @param {ParentNode} node
     */
    function qs(selectors, node = document) {
        return node.querySelector(selectors);
    }

    /**
     * Returns all elements that are descendants of node that matches selectors.
     * @param {string} selectors
     * @param {ParentNode} node
     */
    function qsa(selectors, node = document) {
        return node.querySelectorAll(selectors);
    }

    /**
     * Extracts the entity type and ID from a MusicBrainz URL (can be incomplete and/or with additional path components and query parameters).
     * @param {string} url URL of a MusicBrainz entity page.
     * @returns {{ type: string, mbid: string } | undefined} Type and ID.
     */
    function extractEntityFromURL(url) {
        const entity = url.match(/(area|artist|event|genre|instrument|label|mbid|place|recording|release|release-group|series|url|work)\/([0-9a-f-]{36})(?:$|\/|\?)/);
        return entity ? {
            type: entity[1],
            mbid: entity[2]
        } : undefined;
    }

    /**
     * Returns a promise that resolves after the given delay.
     * @param {number} ms Delay in milliseconds.
     */
    function delay(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    // Rate limiting implementation
    function rateLimitedQueue(operation, interval) {
        let queue = Promise.resolve();
        return (...args) => {
            const result = queue.then(() => operation(...args));
            queue = queue.then(() => delay(interval), () => delay(interval));
            return result;
        };
    }

    /**
     * Limits the number of requests for the given operation within a time interval.
     * @param {Function} operation Operation that should be rate-limited.
     * @param {number} interval Time interval (in ms).
     * @param {number} requestsPerInterval Maximum number of requests within the interval.
     * @returns {Function} Rate-limited version of the given operation.
     */
    function rateLimit(operation, interval, requestsPerInterval = 1) {
        if (requestsPerInterval == 1) {
            return rateLimitedQueue(operation, interval);
        }
        const queues = Array(requestsPerInterval).fill().map(() => rateLimitedQueue(operation, interval));
        let queueIndex = 0;
        return (...args) => {
            queueIndex = (queueIndex + 1) % requestsPerInterval;
            return queues[queueIndex](...args);
        };
    }

    /**
     * Calls to the MusicBrainz API are limited to one request per second.
     * https://musicbrainz.org/doc/MusicBrainz_API
     */
    const callAPI = rateLimit(fetch, 1000);

    /**
     * Makes a request to the MusicBrainz API of the currently used server and returns the results as JSON.
     * @param {string} endpoint Endpoint (e.g. the entity type) which should be queried.
     * @param {Record<string,string>} query Query parameters.
     * @param {string[]} inc Include parameters which should be added to the query parameters.
     */
    async function fetchFromAPI(endpoint, query = {}, inc = []) {
        if (inc.length) {
            query.inc = inc.join(' ');
        }
        query.fmt = 'json';
        const headers = {
            'Accept': 'application/json',
        };
        const response = await callAPI(`https://musicbrainz.org/ws/2/${endpoint}?${new URLSearchParams(query)}`, { headers });
        if (response.ok) {
            return response.json();
        } else {
            throw response;
        }
    }

    function fetchURL(url, options) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                url: url,
                onload: function (response) {
                    if (400 <= response.status) {
                        reject(new Error(`HTTP error! Status: ${response.status}`,
                            { cause: response }));
                    } else {
                        resolve(response);
                    }
                },
                onabort: function (error) {
                    reject(new Error("The request was aborted.",
                        { cause: error }));
                },
                onerror: function (error) {
                    reject(new Error("There was an error with the request. See the console for more details.",
                        { cause: error }));
                },
                ontimeout: function (error) {
                    reject(new Error("The request timed out.",
                        { cause: error }));
                },
                ...options,
            });
        });
    }

    const editNoteSeparator = '\n—\n';

    /**
     * Adds the given message and a footer for the active userscript to the edit note.
     * @param {string} message Edit note message.
     */
    function addMessageToEditNote(message) {
        /** @type {HTMLTextAreaElement} */
        const editNoteInput = qs('#edit-note-text, .edit-note');
        const previousContent = editNoteInput.value.split(editNoteSeparator);
        setReactTextareaValue(editNoteInput, buildEditNote(...previousContent, message));
    }

    /**
     * Builds an edit note for the given message sections and adds a footer section for the active userscript.
     * Automatically de-duplicates the sections to reduce auto-generated message and footer spam.
     * @param {...string} sections Edit note sections.
     * @returns {string} Complete edit note content.
     */
    function buildEditNote(...sections) {
        sections = sections.map((section) => section.trim());
        if (typeof GM_info !== 'undefined') {
            sections.push(`${GM_info.script.name} (v${GM_info.script.version}, https://github.com/YoGo9/Scripts)`);
        }
        // drop empty sections and keep only the last occurrence of duplicate sections
        return sections
            .filter((section, index) => section && sections.lastIndexOf(section) === index)
            .join(editNoteSeparator);
    }

    function displayError(element, error, selector = "") {
        let p = element.querySelector("p.wikidata-converter-error");
        if (!p) {
            p = document.createElement("p");
            p.className = "error wikidata-converter-error";
            p.style.wordBreak = "break-word";
            if (selector) {
                element = element.querySelector(selector) || element;
            }
            element.insertAdjacentElement("afterend", p);
        }
        p.textContent = error.message;
    }

    function clearError(element) {
        let p = element.querySelector("p.wikidata-converter-error");
        if (p) {
            p.remove();
        }
    }

    /**
     * Checks if a URL is a Wikipedia link
     * @param {string} link URL to check
     * @returns {boolean} True if it's a Wikipedia link
     */
    function isWikipediaLink(link) {
        return link.match(/^https?:\/\/([a-z]+)\.wikipedia\.org/i) !== null;
    }

    /**
     * Checks if a URL is a Wikidata link
     * @param {string} link URL to check
     * @returns {boolean} True if it's a Wikidata link
     */
    function isWikidataLink(link) {
        return link.match(/^https?:\/\/(www\.)?wikidata\.org\/wiki\/Q[0-9]+/i) !== null;
    }

    /**
     * Extracts the language code and article title from a Wikipedia URL
     * @param {string} wikipediaUrl The full Wikipedia URL
     * @returns {Object} Object containing language and title
     */
    function parseWikipediaUrl(wikipediaUrl) {
        const match = wikipediaUrl.match(/^https?:\/\/([a-z]+)\.wikipedia\.org\/wiki\/(.+)$/i);
        if (!match) return null;

        return {
            language: match[1],
            title: decodeURIComponent(match[2])
        };
    }

    /**
     * Converts a Wikipedia URL to a Wikidata URL
     * @param {string} wikipediaUrl Full Wikipedia URL
     * @returns {Promise<string>} Promise resolving to Wikidata URL
     */
    async function getWikidataUrlFromWikipedia(wikipediaUrl) {
        const wikipediaInfo = parseWikipediaUrl(wikipediaUrl);
        if (!wikipediaInfo) {
            throw new Error("Invalid Wikipedia URL format");
        }

        // Call the Wikipedia API to get the Wikidata entity ID
        const apiUrl = `https://${wikipediaInfo.language}.wikipedia.org/w/api.php?action=query&prop=pageprops&titles=${encodeURIComponent(wikipediaInfo.title)}&format=json&origin=*`;

        try {
            const response = await fetchURL(apiUrl);
            const data = JSON.parse(response.responseText);

            // Extract the page ID (first key in pages object)
            const pages = data.query.pages;
            const pageId = Object.keys(pages)[0];

            if (pageId === "-1") {
                throw new Error("Wikipedia page not found");
            }

            // Get the Wikidata entity ID
            const wikidataId = pages[pageId].pageprops?.wikibase_item;

            if (!wikidataId) {
                throw new Error("No Wikidata entity found for this Wikipedia article");
            }

            return `https://www.wikidata.org/wiki/${wikidataId}`;
        } catch (error) {
            console.error("Error fetching Wikidata ID:", error);
            throw new Error("Failed to get Wikidata ID: " + (error.message || "Unknown error"));
        }
    }

    function fixLinkOnNonURLPage(span) {
        const tableRow = span.parentElement.parentElement;
        const observer = new MutationObserver(function (mutations, observer) {
            mutations.forEach(function (mutation) {
                if (mutation.addedNodes.length > 0
                    && mutation.addedNodes.item(0).querySelector("div.dialog")) {
                    setReactInputValue(document.querySelector("div.dialog input.raw-url"), tableRow.getAttribute("newLink"));
                    document.querySelector("div.dialog button.positive").click();
                    observer.disconnect();
                    addMessageToEditNote(tableRow.getAttribute("oldLink")
                        + " → "
                        + tableRow.getAttribute("newLink"));
                }
            });
        });
        observer.observe(document.querySelector("#url-input-popover-root") || document.body,
            { childList: true });
        if (tableRow.getAttribute("newLink")) {
            tableRow.querySelector("td.link-actions > button.edit-item").click();
            return;
        }
        tableRow.querySelector(".wikidata-converter-button").disabled = true;
        clearError(tableRow);
        getWikidataUrlFromWikipedia(tableRow.querySelector("td > a").href)
            .then(function (wikidataLink) {
                tableRow.setAttribute("oldLink", tableRow.querySelector("td > a").href);
                tableRow.setAttribute("newLink", wikidataLink);
                tableRow.querySelector("td.link-actions > button.edit-item").click();
            })
            .catch(function (error) {
                console.warn(error);
                displayError(tableRow, error, "a.url");
                observer.disconnect();
            })
            .finally(function () {
                tableRow.querySelector(".wikidata-converter-button").disabled = false;
            });
    }

    function addFixerUpperButton(currentSpan) {
        const tableRow = currentSpan.parentElement.parentElement;
        const linkElement = tableRow.querySelector("a.url");
        if (!linkElement || isWikidataLink(linkElement.href) || !isWikipediaLink(linkElement.href) ||
            tableRow.querySelector('.wikidata-converter-button')) {
            return;
        }
        let button = document.createElement('button');
        button.addEventListener("click", (function () { fixLinkOnNonURLPage(currentSpan); }));
        button.type = 'button';
        button.innerHTML = "Convert to Wikidata";
        button.className = 'styled-button wikidata-converter-button';
        button.style.float = 'right';

        let td = document.createElement('td');
        td.className = "wikidata-converter-td";
        td.appendChild(button);
        currentSpan.parentElement.parentElement.appendChild(td);
    }

    function highlightWikipediaLinks() {
        document.querySelectorAll(".external_links .wikipedia-favicon")
            .forEach(function (listItem) {
                const wikiLink = listItem.querySelector('a').href;
                if (isWikipediaLink(wikiLink) && !isWikidataLink(wikiLink)) {
                    const linkButton = document.createElement('a');
                    linkButton.className = "styled-button wikidata-converter-button";
                    linkButton.style.float = "right";
                    linkButton.textContent = "Convert to Wikidata";
                    const entity = extractEntityFromURL(document.location.href);
                    fetchFromAPI(entity.type + "/" + entity.mbid,
                        { "inc": "url-rels" })
                        .then((response) => {
                            let urlID = false;
                            for (const urlObject of response.relations) {
                                if (urlObject.url.resource == wikiLink) {
                                    urlID = urlObject.url.id;
                                    break;
                                }
                            }
                            if (urlID) {
                                linkButton.href = document.location.origin + "/url/"
                                    + urlID + "/edit";
                                listItem.appendChild(linkButton);
                            }
                        })
                        .catch((error) => {
                            console.error(error);
                            displayError(listItem, error, ".wikidata-converter-button");
                        });
                }
            });
    }

    function runUserscript() {
        highlightWikipediaLinks();
        const target = document.querySelector("#external-links-editor-container");
        if (target) {
            const observer = new MutationObserver(function (mutations) {
                mutations.forEach(function (mutation) {
                    if (mutation.addedNodes.length > 0
                        && (mutation.addedNodes.item(0).id == "external-links-editor"
                            || (mutation.addedNodes.item(0).classList
                                && mutation.addedNodes.item(0).classList.contains("url")
                                && isWikipediaLink(mutation.addedNodes.item(0).href)))) {
                        document.querySelectorAll(".wikipedia-favicon")
                            .forEach(addFixerUpperButton);
                    }
                    if (mutation.removedNodes.length > 0
                        && mutation.removedNodes.item(0).classList
                        && mutation.removedNodes.item(0).classList.contains("url")) {
                        if (mutation.target.nextElementSibling &&
                            mutation.target.nextElementSibling.classList.contains("wikidata-converter-td")) {
                            mutation.target.nextElementSibling.remove();
                        }
                        const tableRow = mutation.target.parentElement;
                        tableRow.removeAttribute("oldLink");
                        tableRow.removeAttribute("newLink");
                        clearError(tableRow);
                    }
                });
            });
            observer.observe(target, { childList: true, subtree: true });
        }
    }

    /**
     * Waits for an element to appear in the DOM.
     * @param {string} selector CSS selector for the element to wait for.
     * @param {ParentNode} parent The parent node to observe for changes. Defaults to document.body.
     * @param {number} timeout Maximum time to wait in milliseconds.
     * @returns {Promise<HTMLElement>} A Promise that resolves with the found element, or rejects on timeout.
     */
    function waitForElement(selector, parent = document.body, timeout = 5000) {
        return new Promise((resolve, reject) => {
            const observer = new MutationObserver((mutations, obs) => {
                const element = qs(selector, parent);
                if (element) {
                    obs.disconnect();
                    clearTimeout(timer);
                    resolve(element);
                }
            });

            const timer = setTimeout(() => {
                observer.disconnect();
                reject(new Error(`Timed out waiting for element: ${selector}`));
            }, timeout);

            observer.observe(parent, { childList: true, subtree: true });

            // Check immediately in case the element is already there
            const element = qs(selector, parent);
            if (element) {
                observer.disconnect();
                clearTimeout(timer);
                resolve(element);
            }
        });
    }

    /**
     * Waits for an element to be removed from the DOM.
     * @param {string} selector CSS selector for the element to wait for its removal.
     * @param {ParentNode} parent The parent node to observe for changes. Defaults to document.body.
     * @param {number} timeout Maximum time to wait in milliseconds.
     * @returns {Promise<void>} A Promise that resolves when the element is removed, or rejects on timeout.
     */
    function waitForElementRemoval(selector, parent = document.body, timeout = 5000) {
        return new Promise((resolve, reject) => {
            // Check immediately if element is already gone
            if (!qs(selector, parent)) {
                resolve();
                return;
            }

            const observer = new MutationObserver((mutations, obs) => {
                if (!qs(selector, parent)) {
                    obs.disconnect();
                    clearTimeout(timer);
                    resolve();
                }
            });

            const timer = setTimeout(() => {
                observer.disconnect();
                reject(new Error(`Timed out waiting for element removal: ${selector}`));
            }, timeout);

            observer.observe(parent, { childList: true, subtree: true });
        });
    }

    /**
     * Handles the relationship dialog, setting the type to "Wikidata / Wikidata page for".
     * @param {HTMLElement} dialog The relationship dialog element.
     */
    async function handleRelationshipDialog(dialog) {
        // Wait for the dialog to be fully interactive
        await delay(100); // Optimized delay

        // Attempt to click the type input to open the dropdown
        const typeInput = await waitForElement("input[id^='relationship-type-']", dialog, 2000); // Optimized timeout
        if (typeInput) {
            typeInput.click();
            await delay(50); // Optimized delay
        } else {
            console.warn("Type input not found in relationship dialog. Skipping type selection.");
            return;
        }

        const wikidataOptionTexts = ["Wikidata / Wikidata page for", "Wikidata page for / Wikidata"];
        let wikidataOption = null;

        // First, try to find the option by text content among all list items
        const optionsContainer = document.body; // Autocomplete options are often appended directly to body
        const allOptions = qsa("li[role='option']", optionsContainer);
        for (const option of allOptions) {
            if (wikidataOptionTexts.includes(option.textContent.trim())) {
                wikidataOption = option;
                break;
            }
        }

        if (wikidataOption) {
            wikidataOption.click();
            await delay(50); // Optimized delay
        } else {
            console.warn("Specific Wikidata option by text not found. Attempting to type and select.");
            // Fallback: Type "Wikidata / Wikidata page for" into the search input and select the first result
            const searchInput = await waitForElement(".ui-autocomplete-input", dialog, 2000); // Optimized timeout
            if (searchInput) {
                setReactInputValue(searchInput, "Wikidata / Wikidata page for");
                await delay(300); // Optimized delay for autocomplete results to populate

                // After typing, try to find the option again by text content in the new results
                const updatedOptions = qsa("li[role='option']", optionsContainer);
                for (const option of updatedOptions) {
                    if (wikidataOptionTexts.includes(option.textContent.trim())) { // Check both variations again
                        wikidataOption = option;
                        break;
                    }
                }

                if (wikidataOption) {
                    wikidataOption.click();
                    await delay(50); // Optimized delay
                } else {
                    console.warn("Could not find autocomplete results for Wikidata after typing. Manual intervention may be needed.");
                }
            } else {
                console.warn("Autocomplete search input not found. Manual intervention may be needed.");
            }
        }

        // Click the "Done" button
        const doneButton = qs("div.buttons > div > button", dialog);
        if (doneButton) {
            doneButton.click();
            await delay(100); // Optimized delay
        } else {
            console.warn("Done button not found in relationship dialog.");
        }
    }

    async function fixLinkURLEdit(row) {
        const urlInput = row.querySelector("input#id-edit-url\\.url");
        const convertButton = row.querySelector("button.wikidata-converter-button");
        urlInput.setAttribute("oldLink", urlInput.value);
        convertButton.disabled = true;
        clearError(row);

        let conversionSuccessful = false;
        let allRelationshipsHandled = false; // Flag to track if all relationships were either converted or removed

        try {
            const wikidataURL = await getWikidataUrlFromWikipedia(urlInput.value);
            setReactInputValue(urlInput, wikidataURL);
            addMessageToEditNote(urlInput.getAttribute("oldLink") + " → " + wikidataURL);
            conversionSuccessful = true; // Mark conversion as successful

            const relationshipEditor = qs("#relationship-editor");
            if (relationshipEditor) {
                const wikipediaRelationshipRows = Array.from(relationshipEditor.querySelectorAll("tr.wikipedia-page-for"));
                let relationshipsProcessedCount = 0;
                let totalRelationshipsToProcess = 0;

                for (const tr of wikipediaRelationshipRows) {
                    const relationshipItems = Array.from(tr.querySelectorAll(".relationship-item"));
                    totalRelationshipsToProcess += relationshipItems.length;

                    for (const item of relationshipItems) {
                        const editButton = item.querySelector(".edit-item");
                        if (editButton) {
                            editButton.click();

                            try {
                                const dialog = await waitForElement("#edit-relationship-dialog", document.body, 5000);
                                await handleRelationshipDialog(dialog);
                                await waitForElementRemoval("#edit-relationship-dialog", document.body, 5000);
                                await delay(300);
                                relationshipsProcessedCount++;
                            } catch (dialogError) {
                                console.error(`Failed to fully process relationship dialog for item: ${dialogError.message}. Attempting recovery.`);
                                const currentDialog = qs("#edit-relationship-dialog");
                                if (currentDialog) {
                                    console.warn("Dialog still present after error. Attempting to force close.");
                                     const doneButton = qs("div.buttons > div > button", currentDialog);
                                     if (doneButton) {
                                         doneButton.click();
                                         await delay(200);
                                         try {
                                             await waitForElementRemoval("#edit-relationship-dialog", document.body, 2000);
                                             console.log("Dialog successfully force-closed and removed.");
                                         } catch (forceCloseError) {
                                             console.error(`Failed to force-close dialog: ${forceCloseError.message}. This might cause issues with subsequent operations.`);
                                         }
                                     } else {
                                         console.warn("Done button not found in current dialog during error recovery. Cannot force close.");
                                     }
                                } else {
                                    console.log("Dialog not found after error, likely already closed or never opened fully.");
                                }
                                await delay(1000);
                                relationshipsProcessedCount++;
                            }
                        } else {
                            relationshipsProcessedCount++;
                        }
                    }
                }
                if (relationshipsProcessedCount === totalRelationshipsToProcess) {
                    allRelationshipsHandled = true;
                }
            } else {
                allRelationshipsHandled = true;
            }
        } catch (error) {
            console.warn(error);
            displayError(row, error, ".wikidata-converter-button");
            conversionSuccessful = false;
        } finally {
            convertButton.disabled = false;

            // Find the "Make all edits votable" checkbox
            const makeVotableCheckbox = qs('#id-edit-url\\.make_votable');

            if (conversionSuccessful) {
                if (allRelationshipsHandled) {
                    // addMessageToEditNote("Automatically submitting edit after successful Wikidata conversion and all relationships handled."); // Removed this line
                    if (makeVotableCheckbox) {
                        makeVotableCheckbox.checked = true;
                        makeVotableCheckbox.dispatchEvent(new Event('change', { bubbles: true })); // Dispatch change event
                        console.log("DEBUG: 'Make edit votable' checkbox checked.");
                    }
                    const submitButton = qs("button.submit.positive");
                    if (submitButton) {
                        console.log("DEBUG: Auto-submission WOULD HAVE OCCURRED (successful conversion scenario).");
                        await delay(500); // Keep delay for realistic timing
                        submitButton.click();
                        console.log("Automatically submitted the edit.");
                    } else {
                        console.warn("DEBUG: Submit button not found. Manual submission required.");
                    }
                } else {
                    console.warn("DEBUG: Not submitting automatically: Wikidata conversion successful, but not all relationships were handled.");
                }
            } else {
                // addMessageToEditNote("Automatically attempting to remove Wikipedia relationships due to failed Wikidata conversion."); // Removed this line
                let relationshipsSuccessfullyRemoved = true;

                const relationshipEditor = qs("#relationship-editor");
                if (relationshipEditor) {
                    const wikipediaRelationshipRows = Array.from(relationshipEditor.querySelectorAll("tr.wikipedia-page-for"));
                    for (const tr of wikipediaRelationshipRows) {
                        const relationshipItems = Array.from(tr.querySelectorAll(".relationship-item"));
                        for (const item of relationshipItems) {
                            const removeButton = item.querySelector(".remove-item");
                            if (removeButton) {
                                console.log("Attempting to remove relationship item due to failed conversion:", item);
                                try {
                                    removeButton.click();
                                    await delay(300);
                                } catch (removeError) {
                                    console.error(`Error clicking remove button for item: ${removeError.message}`);
                                    relationshipsSuccessfullyRemoved = false;
                                }
                            } else {
                                console.warn("Relationship item found without a remove button:", item);
                                relationshipsSuccessfullyRemoved = false;
                            }
                        }
                    }
                } else {
                    console.log("No relationship editor found, assuming no relationships to remove.");
                }
                console.log("Finished attempting to remove Wikipedia relationships. All relationships successfully marked for removal:", relationshipsSuccessfullyRemoved);

                if (relationshipsSuccessfullyRemoved) {
                    if (makeVotableCheckbox) {
                        makeVotableCheckbox.checked = true;
                        makeVotableCheckbox.dispatchEvent(new Event('change', { bubbles: true })); // Dispatch change event
                        console.log("DEBUG: 'Make edit votable' checkbox checked.");
                    }
                    const submitButton = qs("button.submit.positive");
                    if (submitButton) {
                        console.log("DEBUG: Auto-submission WOULD HAVE OCCURRED (failed conversion, successful removal scenario).");
                        await delay(500); // Keep delay for realistic timing
                        submitButton.click();
                        console.log("Automatically submitted the edit after removal.");
                    } else {
                        console.warn("DEBUG: Submit button not found. Manual submission required after removal.");
                    }
                } else {
                    console.warn("DEBUG: Not submitting automatically: Wikidata conversion failed and not all Wikipedia relationships could be marked for removal.");
                }
            }
        }
    }

    async function runOnURLEditPage() {
        const urlInput = document.querySelector("input#id-edit-url\\.url");
        if (!urlInput) {
            return;
        }
        if (!isWikipediaLink(urlInput.value) || isWikidataLink(urlInput.value)) {
            return;
        }

        // Check for pending edits using the 'mp' class in the urlheader
        let hasPendingEdits = false;
        try {
            // Wait for the urlheader to be present, then check for the 'mp' class
            const urlHeaderSpanMp = await waitForElement("div.urlheader h1 span.mp", document.body, 1000); // Shorter timeout for this specific element
            if (urlHeaderSpanMp) {
                hasPendingEdits = true;
                console.log("DEBUG: Pending edits detected: TRUE (via 'mp' class in urlheader).");
            } else {
                console.log("DEBUG: Pending edits detected: FALSE (no 'mp' class in urlheader).");
            }
        } catch (e) {
            console.log("DEBUG: Could not find 'mp' class in urlheader (likely no pending edits or element not yet present):", e.message);
            // If waitForElement times out, it means the element wasn't found, which implies no pending edits via this indicator.
            hasPendingEdits = false;
        }


        if (hasPendingEdits) {
            displayError(urlInput.parentElement, new Error("Pending edits detected for this URL. Automatic conversion/removal aborted. Please resolve pending edits manually."));
            console.warn("DEBUG: Automatic conversion/removal aborted due to pending edits.");
            return; // Stop execution
        }

        const button = document.createElement("button");
        button.type = "button";
        button.textContent = "Convert to Wikidata";
        button.className = "styled-button wikidata-converter-button";
        button.addEventListener("click", function () { fixLinkURLEdit(urlInput.parentElement); });
        urlInput.insertAdjacentElement("afterend", button);

        // Automatically click the convert button after it's added
        console.log("DEBUG: Automatically clicking 'Convert to Wikidata' button.");
        button.click();
    }

    const location = document.location.href;
    if (location.match("^https?://((beta|test)\\.)?musicbrainz\\.(org|eu)/dialog")) {
        if ((new URLSearchParams(document.location.search))
            .get("path").match("^/(artist|event|label|place|release-group|series)/create")) {
            runUserscript();
        }
    } else if (location.match("^https?://((beta|test)\\.)?musicbrainz\\.(org|eu)/url")) {
        runOnURLEditPage();
    } else {
        runUserscript();
    }

})();
