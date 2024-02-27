const core = require(`@actions/core`);
const github = require(`@actions/github`);
const azdev = require(`azure-devops-node-api`);

async function main() {
	const payload = github.context.payload;
	const issueOrPr = payload.issue || payload.pull_request;
	const isIssue = payload.issue != null;
	const isPR = payload.pull_request != null;

	if (core.getInput('label') && !issueOrPr.labels.some(label => label.name === core.getInput('label'))) {
		console.log(`Action was configured to only run when issue or PR has label ${core.getInput('label')}, but we couldn't find it.`);
		return;
	}

	let adoClient = null;

	try {
		const orgUrl = "https://dev.azure.com/" + core.getInput('ado_organization');
		const adoAuthHandler = azdev.getPersonalAccessTokenHandler(process.env.ado_token);
		const adoConnection = new azdev.WebApi(orgUrl, adoAuthHandler);
		adoClient = await adoConnection.getWorkItemTrackingApi();
	} catch (e) {
		console.error(e);
		core.setFailed('Could not connect to ADO');
		return;
	}

	try {
		if (!core.getInput('ado_dont_check_if_exist')) {
			// go check to see if work item already exists in azure devops or not
			// based on the title and tags.
			console.log("Check to see if work item already exists");
			const existingID = await find(issueOrPr);
			if (!existingID) {
				console.log("Could not find existing ADO workitem, creating one now");
			} else {
				console.log("Found existing ADO workitem: " + existingID + ". No need to create a new one");
				return;
			}
		}

		const workItem = await create(payload, adoClient);

		// Add the work item number at the end of the github issue body.
		const currentBody = issueOrPr.body || "";
		issueOrPr.body = currentBody + "\n\nAB#" + workItem.id;
		const octokit = new github.GitHub(process.env.github_token);

		if (isIssue) {
			await octokit.issues.update({
				owner: payload.repository.owner.login,
				repo: payload.repository.name,
				issue_number: issueOrPr.number,
				body: issueOrPr.body
			});
		} else if (isPR) {
			await octokit.pulls.update({
				owner: payload.repository.owner.login,
				repo: payload.repository.name,
				pull_number: issueOrPr.number,
				body: issueOrPr.body
			});
		}

		// set output message
		if (workItem != null || workItem != undefined) {
			console.log(`Work item successfully created or found: ${workItem.id}`);
			core.setOutput(`id`, `${workItem.id}`);
		}
	} catch (error) {
		console.log("Error: " + error);
		core.setFailed();
	}
}

function formatTitle(payload) {
	const issueOrPr = payload.issue || payload.pull_request;
	const isIssue = payload.issue != null;

	return `[GitHub ${isIssue ? "issue" : "PR"} #${issueOrPr.number}] ${issueOrPr.title}`;
}

async function formatDescription(payload) {
	console.log('Creating a description based on the github issue');

	const issueOrPr = payload.issue || payload.pull_request;
	const isIssue = payload.issue != null;

	const octokit = new github.GitHub(process.env.github_token);

	// ?jwt=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJnaXRodWIuY29tIiwiYXVkIjoicmF3LmdpdGh1YnVzZXJjb250ZW50LmNvbSIsImtleSI6ImtleTUiLCJleHAiOjE3MDkwMjk1OTQsIm5iZiI6MTcwOTAyOTI5NCwicGF0aCI6Ii8xNDIxNjIvMzA4MDkxNTkwLTMwOGMyNWZlLWZlZjYtNDVlYy1hMzJjLWJlYjZiNGFhZmJjOC5wbmc_WC1BbXotQWxnb3JpdGhtPUFXUzQtSE1BQy1TSEEyNTYmWC1BbXotQ3JlZGVudGlhbD1BS0lBVkNPRFlMU0E1M1BRSzRaQSUyRjIwMjQwMjI3JTJGdXMtZWFzdC0xJTJGczMlMkZhd3M0X3JlcXVlc3QmWC1BbXotRGF0ZT0yMDI0MDIyN1QxMDIxMzRaJlgtQW16LUV4cGlyZXM9MzAwJlgtQW16LVNpZ25hdHVyZT0zODg5NzE2YTlkZTRmY2UxOGJiOTI1Yjg1MzQzNzVkNjgyYWZjOTY4OWUxMzQzOTQxYWM0MzUzMGNiMThmNTIwJlgtQW16LVNpZ25lZEhlYWRlcnM9aG9zdCZhY3Rvcl9pZD0wJmtleV9pZD0wJnJlcG9faWQ9MCJ9.8w3CjRdUUeWMOrGJ3WinlKA1T7JH7U2YsZy0sfI-02g"
	// Remove potential tokens found in the issue or PR body to avoid errors when creating work items.
	const safeBody = issueOrPr.body.replace(/\?jwt=[^"]+/g, "");

	const bodyWithMarkdown = await octokit.markdown.render({
		text: safeBody || "",
		mode: "gfm",
		context: payload.repository.full_name
	});

	return `
		<hr>
	  <em>This work item is a mirror of the GitHub
		<a href="${issueOrPr.html_url}" target="_new">${isIssue ? "issue" : "PR"} #${issueOrPr.number}</a>.
		It will not auto-update when the GitHub ${isIssue ? "issue" : "PR"} changes, please check the original ${isIssue ? "issue" : "PR"} on GitHub for updates.
		</em>
		<hr>
		<br>
		${bodyWithMarkdown.data}
	`;
}

async function create(payload, adoClient) {
	const issueOrPr = payload.issue || payload.pull_request;
	const botMessage = await formatDescription(payload);
	const shortRepoName = payload.repository.full_name.split("/")[1];
	const tags = core.getInput("ado_tags") ? core.getInput("ado_tags") + ";" + shortRepoName : shortRepoName;
	const itemType = core.getInput("ado_work_item_type") ? core.getInput("ado_work_item_type") : "Bug";

	console.log(`Starting to create a ${itemType} work item for GitHub issue or PR #${issueOrPr.number}`);

	const patchDocument = [
		{
			op: "add",
			path: "/fields/System.Title",
			value: formatTitle(payload),
		},
		{
			op: "add",
			path: "/fields/System.Description",
			value: botMessage,
		},
		{
			op: "add",
			path: "/fields/Microsoft.VSTS.TCM.ReproSteps",
			value: botMessage,
		},
		{
			op: "add",
			path: "/fields/System.Tags",
			value: tags,
		},
		{
			op: "add",
			path: "/relations/-",
			value: {
				rel: "Hyperlink",
				url: issueOrPr.html_url,
			},
		}
	];

	if (core.getInput('parent_work_item')) {
		let parentUrl = "https://dev.azure.com/" + core.getInput('ado_organization');
		parentUrl += '/_workitems/edit/' + core.getInput('parent_work_item');

		patchDocument.push({
			op: "add",
			path: "/relations/-",
			value: {
				rel: "System.LinkTypes.Hierarchy-Reverse",
				url: parentUrl,
				attributes: {
					comment: ""
				}
			}
		});
	}

	patchDocument.push({
		op: "add",
		path: "/fields/System.AreaPath",
		value: core.getInput('ado_area_path'),
	});

	if (core.getInput('ado_product')) {
		patchDocument.push({
			op: "add",
			path: "/fields/OSG.Product",
			value: core.getInput('ado_product'),
		});
	}

	let workItemSaveResult = null;

	try {
		console.log('Creating work item');
		workItemSaveResult = await adoClient.createWorkItem(
			(customHeaders = []),
			(document = patchDocument),
			(project = core.getInput('ado_project')),
			(type = itemType),
			(validateOnly = false),
			(bypassRules = false)
		);

		// if result is null, save did not complete correctly
		if (workItemSaveResult == null) {
			workItemSaveResult = -1;

			console.log("Error: createWorkItem failed");
			console.log(`WIT may not be correct: ${wit}`);
			core.setFailed();
		} else {
			console.log("Work item successfully created");
		}
	} catch (error) {
		workItemSaveResult = -1;

		console.log("Error: createWorkItem failed");
		console.log(patchDocument);
		console.log(error);
		core.setFailed(error);
	}

	if (workItemSaveResult != -1) {
		console.log(workItemSaveResult);
	}

	return workItemSaveResult;
}

async function find(issueOrPr) {
	console.log('Checking if a work item already exists for #' + issueOrPr.number);

	// Isues or PRs that got mirrored have the AB#123456 tag in the body.
	// So we can simply look for this and extract the number.

	if (issueOrPr.body != null && issueOrPr.body.includes("AB#")) {
		const regex = /AB#(\d+)/g;
		const matches = regex.exec(issueOrPr.body);
		if (matches != null) {
			return matches[1];
		}
	}

	return null;
}

main();
