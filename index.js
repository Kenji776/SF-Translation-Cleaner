/**
 * @Name SF-Translation-Cleaner
 * @Date 2/1/2023
 * @Author Daniel Llewellyn
 * @Description This is a Node.js application that will remove invalid translation data from a file by comparing the translation definition to existing meta data to remove translations for things that do not exist. This will
 allow you to move translation files between similar but not identical orgs (orgs that contain a subset of the original metadata).
 */
 
const configFileName = "config.json";
const fs = require("fs");
const path = require("path");
const readline = require('readline');
const spawn = require("child_process");
var metadataTypes = [];
var xml2js = require('xml2js');
var parseString = xml2js.parseString;

let customLabelsData = null;

//JSON object generated from settings->Address.settings-meta.xml metadata
let addressData = {};


//entries to write into the program log on completion
let logEntries = [];

//entries to write into the program  error log on completion
let errorLogEntries = [];

//object containing cached information read from files to reduce file reads 
let cachedFileData = {}; 

//invalid translation entries as scraped from Salesforce provided error logs that are stored in the errorLogs folder. Can be added to the config.json so they don't 
//have to be recalculated on every run.
let invalidEntries = [];

//default config options
let config = {

};

//allows for user input
const keypress = async () => {
	process.stdin.setRawMode(true);
	fs.readSync(0, Buffer.alloc(1), 0, 1);
}

function TranslationObject(sourceObject){
	this.metadataType;
	this.source;
	this.target;
	this.objectName;
	this.elementName;
	
	let idParts = sourceObject['$'].id.split('.');
	this.metadataType = idParts[0];
	this.objectName = idParts[1];
	this.elementName = idParts[2];
	this.source = sourceObject.source[0];
	this.target = sourceObject.target[0];
}

function CleanReport(){
	this.totalLines;
	this.removedLines;
	this.language;
	
	this.metadataTypes = {};
}
/**
* @Description Entry point function. Loads configuration, checks it for validity and calls the menu to display to the user
*/
async function init() {
    console.log("                                    Salesforce Translation Cleaner\r\n");
    console.log("                                     Author: Daniel Llewellyn\r\n");

    let d = new Date();
    d.toLocaleString();

    log("Started process at" + d, false);
	
	log('Starting cleaning of translation files',true,'green');
    //load the configuration from the JSON file.
    let loadedConfig = loadConfig(configFileName);
    config = { ...config, ...loadedConfig };	
	
	
	//scrape any invalid translation entries we can from error logs so we don't include them in our generated files.
	invalidEntries = await processErrorLogEntries(config.errorLogLocation);
	
	//because we don't want to have to read the massive translation file for every read of a custom label we load it into memory
	customLabelsData = readFile(`${config.orgDataLocation}\\labels\\CustomLabels.labels-meta.xml`);
	
	//structure the address data into a JSON object so that way we can easily check for countries/states and discard ones that don't exist.
	addressData = await loadAddressData();
	
	let processingResult = await processTranslations(config.sourceDir, config.destDir, config.sourceFilesType);
	
	log('----------------------------  Final Result-----------------------',true,'green');
	log(JSON.stringify(processingResult, null, 2));
	
	//generate the spreadsheet with the totals	
	await generateFinalReport();
		
	if(config.autoZip){
		let filename = `Translations Compressed ${d.toISOString().replace(/T/, ' ').replace(/\..+/, '').replaceAll(':','-')}`;
		await zipResults(filename, config.destDir);
	}
	
	log('All process translations finished. Please import your result file ',true,'green');

	finish();
	
	

}


/**
* @description iterates over the translation files in the given directory and sends them for cleaning.
* @param {string} sourceDir the local folder the translation files (.stf or xlf are located).
* @param {string} destDir the local folder the cleaned files should be written to
* @param {string} fileType the file type filter to use to only process files of the given type. Should be .stf or .xlf.
*/
async function processTranslations(sourceDir='input', destDir='output', fileType='.stf') {
	log(`Reading ${fileType} files from ${sourceDir}`,true);
	let promises = [];
	
	try {
        // Get the files as an array
        let files = await fs.promises.readdir( sourceDir );

		//filter the files to only get the types we are interested in.
		files = files.filter(file => {
			return path.extname(file).toLowerCase() === fileType;
		});

        // Loop them all
        for( const file of files ) {
            // Get the full paths
            const sourcePath = path.join( sourceDir, file );
            const toPath = path.join( destDir, file );

            // Stat the file to see if we have a file or dir
            const stat = await fs.promises.stat( sourcePath );

            if( stat.isFile() ){
				if(fileType == '.stf') {
					promises.push( cleanStfFile(sourceDir, file, destDir) );
				}
				
				else if(fileType == '.xlf') promises.push( cleanXlfFile(sourceDir, file, destDir) );
			}
            else if( stat.isDirectory() ){
                //log( sourcePath + ' is a directory. skipping. ' );
			}
        }
		
    }
    catch( e ) {
        log( "Error reading source translation files to send for processing " + e.message, true, 'red' );
		if(config.pauseOnError) await keypress();
    }

	//once all promises the from the cleanStfFile function calls are resolved then log them. This doesn't seem to work quite right as I don't think the the cleanStfFile function is resolving/returning its
	//promises correctly.
	return Promise.all(promises);
}

/**
* @description cleans the given translation .xlf file of bad references by reading each line and checking for it's related metadata in the local file system's project folder. 
* @param {string} sourceDir the local directory where the translation file is located
* @param {string} file the name of the translation file to read. Should be a .stf file.
* @param {destDir} the destination directory to write the cleaned file to.

* @note This function is not complete, hasn't been tested and probably won't work. This is only a rough outline of what would be needed to parse and clean Xlf files.
*/
async function cleanXlfFile(sourceDir, file, destDir){
	const filePath = path.join( sourceDir, file );
	
	let fileData = fs.readFileSync(filePath, 'utf-8', function (err) {
		log('Could not read xlf translation file '+sourceDir+'\\'+file+'. ' + err.message, true, "red");
		return false;
	});
	
	let translationFileData = await xmlToJson(fileData);
	
	let root = translationFileData.xliff.file[0].body[0]['trans-unit'];
	
	//lets remove any untranslated items to reduce processing time
	for (var i = root.length - 1; i >= 0; i--) {
		if (!root[i].hasOwnProperty('target')) { 
			root.splice(i, 1);
		}
	}

	//now that our object has only things that are only translated, lets check and see if this translation has a corresponding metadata entry on the local file system
	for (var i = root.length - 1; i >= 0; i--) {
		let thisTranslation = new TranslationObject(root[i]);
			
		if (!await doesLocalMetadataExist(thisTranslation.metadataType,thisTranslation.objectName,thisTranslation.elementName)) { 
			root.splice(i, 1);
		}
	}
	
	console.log('Finishing cleaning translation root of bad references. There are '+root.length+' remaining valid translations.');
	
	translationFileData.xliff.file[0].body[0]['trans-unit'] = root;
	
	writeXmlFromJSON(translationFileData, destDir, file);
}

/**
* @description cleans the given translation .stf file of bad references by reading each line and checking for it's related metadata in the local file system's project folder.
* @param {string} sourceDir the local directory where the translation file is located
* @param {string} file the name of the translation file to read. Should be a .stf file.
* @param {destDir} the destination directory to write the cleaned file to.
*/
async function cleanStfFile(sourceDir, file, destDir){
	let validDataLines = [];
	let validMetaDataLines = [];
	let headerContent = [];
	let badLines = [];
	let numTranslationLines = 0;
	let totals = {
		details:  {
			sourceDir: sourceDir,
			file: file,
			destDir: destDir,
			valid: 0,
			invalid: 0,
			total: 0,
			validPercent: 0,
			invalidPercent: 0,
			language: '',
			languageCode: ''
			
		},
		ERROR: {
			invalid: 0,
			errors: []
		}
	};
	const filePath = path.join( sourceDir, file );
	
	log('Cleaning File: ' + filePath);
	const fileStream = fs.createReadStream(filePath);
	
	const rl = readline.createInterface({
		input: fileStream,
		crlfDelay: Infinity
	});
		// Note: we use the crlfDelay option to recognize all instances of CR LF
		// ('\r\n') in input.txt as a single line break.

	let startCleaning = false;

	//check each line of our translation file to see if the related metadata exists locally.
	for await (const line of rl) {
		let lineValid = false;
		let lineVal = line;
		let invalidObjects = [];
		
		try{
			if(!startCleaning){			
				let lineParts = line.split(' ');
				if(line.trim().startsWith('# Language: ')){
					log(`Language detected as ${lineParts[2]}`,true,'green');
					totals.details.language = lineParts[2];
				}else if(line.trim().startsWith('Language code: ')){
					log(`Language code detected as ${lineParts[2]}`,true,'green');
					totals.details.languageCode = lineParts[2];
				}
				headerContent.push(line);
			}
			

			if(config.abortOnUntranslated && line.trim() == '------------------OUTDATED AND UNTRANSLATED-----------------') {
				log('End of translatable elements reached. "------------------OUTDATED AND UNTRANSLATED-----------------" encountered. Aborting',true,'yellow');
				break;
			}
			
			if(line.trim().substring(1) === '0' || line.trim().substring(1) === '') continue;
			
			if(!startCleaning && line.trim() === '# KEY	LABEL	TRANSLATION	OUT OF DATE') {
				log('Start of data payload found. Will start cleaning on next line');
				startCleaning = true;
				continue;
			}
			
			if(startCleaning){	
				numTranslationLines++;
				// Each line in input.txt will be successively available here as `line`.
				//console.log(`Line from file: ${line}`);
				
				//the line is tab delimited, so split on tabs to break it into its constituant chunks
				const keys = line.split("\t");
				
				//the 'identifier' of what kind of metadata this is in the the first chunk of the link, deliniated by .
				//EX: PicklistValue.Queue_Share__c.Related_Object.Complaint Analysis
				const metadataParts = keys[0].split('.');
				
				//generally speaking (but not an absolute rule) the parts of the identifier are first the metadata type, second the object it pertains to, and finally the element (field usually) specifically on that object this translation is for
				//some metadata types act differently so you'll see some checks using these variables in ways that are not immediatly intuitive based on their name
				var metadataType = metadataParts[0];
				var objectName = metadataParts[1];
				var elementName = metadataParts[2];
							

				//create a running tally of all the metadata types and their member translations that we either carry over or discard
				if(!totals.hasOwnProperty(metadataType)){
					log('Adding metadata type: ' + metadataType);
					metadataTypes.push(metadataType);
					totals[metadataType] = {
						total: 0,
						valid: 0,
						invalid: 0,
						errors: []
					};
					
				};	
				
				//this if statment isn't 'smart' enough to keep for now. Ideally we'd know for sure that the metadata type is a reference to an object, but we don't know that for sure since
				//there arn't really any hard and fast rules it seems to the format of the translation definitions. So in the future we could probably have a 'lookup' table that checks to see if a given
				//translation type (customfield, picklist value, etc) can use this check or not but for now it's probably safest to skip this even though it will make processing time much longer.
				
				/*
				//if we know this object type isn't valid, skip it.
				if(invalidObjects.indexOf(objectName) > -1) {
					totals[metadataType].invalid++;
					badLines.push(lineVal);
					continue;
				}
				*/
				
			
				//okay this is super annoying. For some reason in the translation file, custom metadata types get the suffix __c when really they should have the suffix __mdt. So if our object ends with __c, check to make sure
				//an object folder actually exists for it. If not, test to see if one exists with __mdt instead and then overwrite the __c with __mdt instead. So for example the custom metadata 
				//Service_Complaint_Analysis_Routing__mdt
				//shows up in our translation file with an entry for a picklist value like this.
				//CustomField.Service_Complaint_Analysis_Routing__c.Complaint_Reason.FieldLabel	Complaint Reason
				//See how that __c is incorrect? We need to change that, but we have no way of knowing ahead of time that this a metadata because the very thing that would tell us that (having an __mdt as it's postfix) is incorrect. So we just test both.
				

					
				//skip this if we are dealing with a standard picklist field.
				if(objectName.toLowerCase() !== 'standard' ){
					let objectnameConverted = objectName.replace('__c','__mdt');
					let originalFolderExists = fileExists(`${config.orgDataLocation}\\objects\\${objectName}`);
					let convertedFolderExists = fileExists(`${config.orgDataLocation}\\objects\\${objectnameConverted}`);
					
					//related to the commented out if statment above, this check 
					if(!originalFolderExists && !convertedFolderExists && !invalidObjects.indexOf(objectName) === -1){
						log(`\n\n\n---------- Could not locate folder for object ${objectName} or potential metadata object of ${objectnameConverted} at location ${config.orgDataLocation}\\objects\\}\n\n\n`,true,'yellow');
						totals[metadataType].invalid++;
						badLines.push(lineVal);
						invalidObjects.push(objectName);
						continue;
					}
					else if(objectName && !originalFolderExists && !convertedFolderExists){
						objectName = objectName.replace('__c','__mdt');
						log(`Object ${objectName} detected as custom metadata (__mdt). Replacing __c with __mdt`,true,'yellow');
					}
				}
				


				
				if(config.translationTypes.hasOwnProperty(metadataType) && config.translationTypes[metadataType] == true){
					log('Evaluating Existance of ' + objectName + '.' + elementName);
					totals[metadataType].total++;
					let lineValid = false;
					
	
					
					
					//exclude items that are forcefully excluded	
					/*
					config.forceExclude.forEach((element) => {
						console.log(keys[0] + ' VS ' + element);
						if(keys[0].includes(element)){
							log('Excluding ' + keys[0] + ' due to forceful exclusion rule entry in config', true, 'yellow');
							keypress();
						}
					});
					*/
					
					if(config.forceExclude.includes(keys[0])){
						log('Excluding ' + keys[0] + ' due to forceful exclusion rule entry in config', true, 'yellow');
					}else if(invalidEntries.includes(keys[0])){
						log('Excluding ' + keys[0] + ' due to automatic detection of being invalid from error logs.', true, 'yellow');
					}else{
						lineValid = await doesLocalMetadataExist(metadataType,objectName,elementName,metadataParts);
					}
					
					if(lineValid){
						
						totals[metadataType].valid++;
	
						//The import process differentiates between data and metadata. I was getting errors for a while about having the two mixed so I wrote this 'filter' logic to have two different import files be generated
						//based on what 'kind' of translation it was. That original error was a red herring and it should be that all the translations generated by the script are in-fact metadata but again we keep this just in case
						//something changes in the future and we need/want to separate import files.
						if(config.importTypes.metadata.indexOf(metadataType) > -1){
							validMetaDataLines.push(lineVal);
						}else{
							validDataLines.push(lineVal);
						}
					}else{
						totals[metadataType].invalid++;
						badLines.push(lineVal);
					}	
				
				}else{
					log(`No translation type specified in config.json for metadata type ${metadataType}. Valid types are ${config.translationTypes}`,true,'red');
					totals[metadataType].invalid++;
					badLines.push(lineVal);
					console.log(config.translationTypes);
				}
			}
		
		}catch(ex){
			log("Erroring processing translation line in file. " + ex.message, true, "red");
			totals[metadataType ? metadataType : 'ERROR'].total++;
			totals[metadataType ? metadataType : 'ERROR'].errors.push("Erroring processing translation line in file. " + ex.message);
			badLines.push(lineVal);
			if(config.pauseOnError) await keypress();
		}
	}
	totals.details.total = numTranslationLines;
	totals.details.invalid = badLines.length;
	totals.details.valid = validDataLines.length + validMetaDataLines.length;
	totals.details.validPercent = totals.details.total != 0 ? Math.round((totals.details.valid/totals.details.total)*100) : 0	
	totals.details.invalidPercent = totals.details.total != 0 ? Math.round((totals.details.invalid/totals.details.total)*100) : 0		


	log('Translation Type Totals for: ' + file);
	log(JSON.stringify(totals, null, 2));
	
	console.log('Writting Translation Files');
	
	if(validMetaDataLines.length > 0){
		writeTranslationFile(destDir, 'metadata_' + file , [...headerContent, ...validMetaDataLines]);	
	}
	
	if(validDataLines.length > 0){
		writeTranslationFile(destDir, 'data_' + file , [...headerContent, ...validDataLines]);	
	}
	
	writeTranslationFile(config.removedTranslationsOutputFolder, file , badLines);

	fs.writeFileSync(`${config.translationLogsLocation}\\${file}.log`, JSON.stringify(totals, null, 2), function(err){
		if(err) {
			return log(err);
		}
		log('Log file saved ' + file + '.log saved' );
	});
	
	
	
	return new Promise((resolve) => {
		resolve(totals);
	});
	
}

/**
* @description Checks the local file system for corresponding data for the given translation entry. This check assumes that all relevant metadata for the org has been downloaded or else this could return false negatives.
* @param {string} metadataType The type of 'thing' this translation is related to. The first part of the translation identifier string EX WorkflowTask.Case.Day_5_Follow_Up_Email_Sent_to_Employee.SubjectLabel => WorkflowTask
* @param {string} objectName The specific object type (in most cases) this translation is related to. It's the second part of the translation identifier string. EX WorkflowTask.Case.Day_5_Follow_Up_Email_Sent_to_Employee.SubjectLabel => Case
* @param {string} elementName the field (in most cases) this translation is related to. The third part of the translation identifier. EX WorkflowTask.Case.Day_5_Follow_Up_Email_Sent_to_Employee.SubjectLabel => Day_5_Follow_Up_Email_Sent_to_Employee
* @return {boolean} true - the corresponding metadata exists on the local filesystem. false - the corresponding metadata does not exist on the local filesystem.
*/
async function doesLocalMetadataExist(metadataType='',objectName='',elementName='',metadataParts){
	let lineValid = false;
	try{
		log(`Checking validity of ${metadataType}  ${objectName} ${elementName}`,true);
		switch(metadataType) {
			case 'ButtonOrLink':
				//local path: \objects\Account\webLinks\Apttus__ViewAgreementHierarchyforAccount.webLink-meta.xml
				//rule def: ButtonOrLink.Account.Apttus__ViewAgreementHierarchyforAccount	View Agreement Hierarchy for Account (Link)	取引先の合意階層を表示（リンク）	-		
				lineValid = fileExists(`${config.orgDataLocation}\\objects\\${objectName}\\webLinks\\${elementName}.webLink-meta.xml`);
				break;

			//When looking for a custom app it is found in the applications directory with a folder named after the 'object' (	
			case 'CustomApp':
				lineValid = fileExists(`${config.orgDataLocation}\\applications\\${objectName}.app-meta.xml`);
				break;
				
			case 'CustomField':
				lineValid = fileExists(`${config.orgDataLocation}\\objects\\${objectName}\\fields\\${elementName}__c.field-meta.xml`);
				break;
				
			case 'LayoutSection':
			
				lineValid = fileExists(`${config.orgDataLocation}\\layouts\\${objectName}-${elementName}.layout-meta.xml`);
				break;
				
			case 'LookupFilter':
				lineValid = fileExists(`${config.orgDataLocation}\\objects\\${objectName}\\fields\\${elementName}__c.field-meta.xml`);
				break;
				
			case 'PicklistValue':
			
				//TODO: Confirm that each individual picklist value actually exists (instead of just assuming it does) as non existing values will cause errors.
				
				//standard picklists
				if(objectName.toLowerCase() == 'standard') {
					//lineValid = fileExists(`${config.orgDataLocation}\\objects\\${objectName}`); //cannot use object type to confirm since the 'objectName' in this case is just 'standard'
					//we need a mapping of every 'standard field name' to it's propert parent object/field name mapping. EX: PicklistValue.Standard.opportunityStage -> Opportunity.Stage
					lineValid = true;
					break;
				}
				
				//global value set picklists, are they just inherently valid? (not sure how to validate these)
				else if(elementName.slice(-5) === '__gsv'){
					
					lineValid = true;
					
					break;
					
				}
				
				//all other picklists
				else{
					//first check to make sure the field even exists before evaluating its picklist values
					let fieldExists = fileExists(`${config.orgDataLocation}\\objects\\${objectName}\\fields\\${elementName}__c.field-meta.xml`);
					
					if(!fieldExists) {
						log(`Object or field ${objectName}.${elementName} do not exist. Skipping picklist value evaluation`);
						break;
					}
					
					let picklistValue = encodeHtmlEntities(metadataParts[3]);
					
					log(`Looking for value ${picklistValue} in text of body`);
					
					let fieldData = getCachedData(metadataType,objectName,elementName);
			
					//TODO: This should probably be replace from just a test search into parseing the picklist XML into a JSON object like we do with the addressCountry/addressState data. We could then search for an element
					//with matching fullname property and check to make sure it's active. That would be a little cleaner and allow us to check for the active flag which this text based search version does not.
					if(fieldData && fieldData.indexOf(`<fullName>${picklistValue}</fullName>`) > -1) lineValid = true;

					break;
				}
				
			case 'RecordType':
				lineValid = fileExists(`${config.orgDataLocation}\\objects\\${objectName}\\recordTypes\\${elementName}.recordType-meta.xml`);
				
				if(!lineValid) break;
				
				//not only do we have to check if the record type exists, we have to check and see if the referenced field does as well
				
				if(metadataParts[3]){
					let recordTypeField = getCachedData(metadataType,objectName,elementName);
			
					let field = encodeHtmlEntities(metadataParts[3]);
			
					if(recordTypeField && recordTypeField.indexOf(`<fullName>${field}</fullName>`) > -1) lineValid = true;
					else lineValid = false;
				}			
				
				break;
				
			case 'ValidationFormula':
				//local path: \objects\Account_Request__c\validationRules\AR_VR01_OnePendingRequest.validationRule-meta.xml
				//rule def: ValidationFormula.Account_Request__c.AR_VR01_OnePendingRequest	There are already pending changes for this Account. Please retry when there are no more pending changes.
				lineValid = fileExists(`${config.orgDataLocation}\\objects\\${objectName}\\validationRules\\${elementName}.validationRule-meta.xml`);
				break;
				
			case 'WebTab':
				//local path: tabs\Apttus_Proposal__AboutProposalManagement.tab-meta.xml
				//rule def: WebTab.Apttus_Proposal__AboutProposalManagement	About Proposal Management
				lineValid = fileExists(`${config.orgDataLocation}\\tabs\\${objectName}.tab-meta.xml`)
				break;
				
			case 'CustomLabel':
				if(customLabelsData && customLabelsData.indexOf(`<fullName>${objectName}</fullName>`) > -1) lineValid = true;						
				break;
				
			case 'ApexSharingReason':
				//local path: objects\Sales_Coach__c\sharingReasons\Coaching_Moment_Coach__c.sharingReason-meta.xml
				//rule def: ApexSharingReason.Sales_Coach__c.Coaching_Moment_Coach	Coaching Moment Coach
				lineValid = fileExists(`${config.orgDataLocation}\\objects\\${objectName}\\sharingReasons\\${elementName}__c.sharingReason-meta.xml`);
				break;
				
			case 'CustomReportType':
				//local path: reportTypes\Accounts_with_Account_Requests.reportType-meta.xml
				//rule def: CustomReportType.Accounts_with_Account_Requests.Name	Accounts w/ Account Requests + User Details - CRTD
				lineValid = fileExists(`${config.orgDataLocation}\\reportTypes\\${objectName}.reportType-meta.xml`);						
			
				break;
				
			case 'CrtLayoutSection':
				lineValid = fileExists(`${config.orgDataLocation}\\reportTypes\\${objectName}.reportType-meta.xml`);
				break;
				
			case 'CrtColumn':
				lineValid = fileExists(`${config.orgDataLocation}\\reportTypes\\${objectName}.reportType-meta.xml`);
				break;
				
			case 'DataCategory':
				//local path: \datacategorygroups\Geo.datacategorygroup-meta.xml
				//rule def: DataCategory.Geo.APAC	APAC
				
				//first check to make sure the Data Category Group even exists before evaluating its DataCategory values
				let dataCategoryGroupExists = fileExists(`${config.orgDataLocation}\\datacategorygroups\\${objectName}.datacategorygroup-meta.xml`);
				
				if(!dataCategoryGroupExists) {
					log(`Data Category Group ${objectName} does not exist. Skipping DataCategory value evaluation`);
					break;
				}
				
				//look for <name>${elementName}</name> in the file with the matching object name
				let dataCategoryData = getCachedData(metadataType,objectName,null);
				
				if(dataCategoryData && dataCategoryData.indexOf(`<name>${elementName}</name>`) > -1) lineValid = true;
								
				break;
				
			case 'DataCategoryGroup':									
				//local path: \datacategorygroups\Geo.datacategorygroup-meta.xml
				lineValid = fileExists(`${config.orgDataLocation}\\datacategorygroups\\${objectName}.datacategorygroup-meta.xml`);
				break;
				
			case 'Scontrol':
				//local path: \scontrols\Apttus_Approval__aptsApprovalBackupApprover.scf-meta.xml
				//rule def: Scontrol.Apttus_Approval__aptsApprovalBackupApprover	aptsApprovalBackupApprover
				lineValid = fileExists(`${config.orgDataLocation}\\scontrols\\${objectName}.scf-meta.xml`);
				break;
				
			case 'StandardFieldHelp':
				//since all objects have the same standard fields we can just check the the object itself exists (since it may not be enabled like 'accountContactRole' or some of the other optional feature objects).
				lineValid = fileExists(`${config.orgDataLocation}\\objects\\${objectName}`); //\\fields\\${elementName}__c.field-meta.xml`);
				break;
				
			case 'WorkflowTask':
				//local path: \workflows\Case.workflow-meta.xml
				//rule def: WorkflowTask.Case.Day_5_Follow_Up_Email_Sent_to_Employee.SubjectLabel	Day 5 Follow Up Email Sent to Employee
				
				//look for <fullName>${elementName}</fullName> in the file with the matching object name
				let workflowData = getCachedData(metadataType,objectName,elementName);
				
				if(workflowData && workflowData.indexOf(`<fullName>${elementName}</fullName>`) > -1) lineValid = true;
				break;
				
			case 'AddressCountry':
				//local path: \settings\Address.settings-meta.xml
				//rule def: AddressCountry.US	United States	Etats -Unis	-
				console.log('Looking for address country: ' + objectName);
				
				if(addressData && addressData.hasOwnProperty(objectName)) lineValid = true;
				break;
				
			case 'AddressState':
				if(addressData && addressData?.[objectName]?.statesByCode?.hasOwnProperty(elementName)) lineValid = true;
				break;
				
			case 'Flow':
				//Flow.Flow.New_OCSD_Order_Request.1.New_OCSD_Order_Request.Field.Status.FieldLabel	Status	Status	-
				//Flow.Flow.New_OCSD_Order_Request.1.New_OCSD_Order_Request.AccountName.FieldInputParameter.label.FieldLabel	"Account Name"	Nombre de la cuenta	-
				let flowExists = fileExists(`${config.orgDataLocation}\\flows\\${elementName}.flow-meta.xml`);

				if(!flowExists) {
					log(`Flow ${elementName} does not exist. Skipping translation`);
					break;
				}
				
				lineValid = true;
				
				console.log(metadataParts);
				
				//only worth additional checks if there is actual enough info to perform a check
				if(metadataParts.length > 5){
					let flowVersion = metadataParts[3];
					let flowScreen = metadataParts[4];
					let flowElementType = metadataParts[5];
					let flowProperry = metadataParts[6]; 
					
					log(`Looking for value ${flowProperry} in text of body`);
					
					let flowData = getCachedData(metadataType,objectName,elementName);
			
					//Super weak check here, but it's better than nothing. Just check to see if the flow propety exists in the flow source file somewhere. We arn't doing any checking to make sure its in the right
					//place or of the right type, just simply that the text from the property exists somewhere in the flow definition file.
					
					//maybe convert the xml content into JSON and check for the sub properties?
					let JSONValid = true;
					
					if(config.checkFlowJSON){
						console.log('\n\n\n------------------ Converting Flow to JSON');
						let flowAsJson = await xmlToJson(flowData);
						
						fs.writeFileSync(`${config.flowJsonLocation}\\${elementName}.json`, JSON.stringify(flowAsJson, null, 2), function(err){
							if(err) {
								return log(err);
							}							
						});	

						log(`Flow JSON Log file saved ${config.flowJsonLocation}\\${elementName}.json log saved` );
						
						console.log(flowAsJson);

						//here we can start checking the structure of the flow's JSON to see if it has matching keys from the translation
						/*
						for(let screen of flowAsJson.Flow.screens){
							console.log('Screen: ' + screen.name + ' VS ' + metadataParts[4]);
							if(screen.name == metadataParts[4]) log('MATCH FOUND',true,'green');
						}*/
						if(!flowAsJson.Flow.screens.find(e => e.name == metadataParts[4])){
							log(`Screen ${metadataParts[4]} does not exist in flow ${elementName}. Skipping translation`,true,'yellow');
							JSONValid = false;
						}	

						else if(metadataParts[5] == 'field' && !flowAsJson.Flow.screens.fields.find(e => e.name == metadataParts[6])){
							log(`Field ${metadataParts[6]} does not exist on screen ${metadataParts[4]} does not exist in flow ${elementName}. Skipping translation`,true,'yellow');
							JSONValid = false;						
						}
						lineValid = JSONValid;						
					}
					
				}
				
				break;
				
			case 'FieldSet':
				//local path: \objects\Apttus_Config2__Order__c\Apttus_Config2__CreateOrderFromPOPageFieldSet.fieldSet-meta.xml
				//rule def: FieldSet.Apttus_Config2__CustomerPOItem__c.Apttus_Config2__CreateOrderFromPOPageFieldSet	Create Order From POPage FieldSet
				lineValid = fileExists(`${config.orgDataLocation}\\objects\\${objectName}\\fieldSets\\${elementName}.fieldSet-meta.xml`);
				break;
				
			case 'QuickAction':
				lineValid = fileExists(`${config.orgDataLocation}\\quickActions\\${objectName}.${elementName}.quickAction-meta.xml`);
				break;
				
			case 'ManagedContentType':
				//TODO: Figure out what local data here pulled from SF metadata can be checked to verify the existance of this type of thing.
				lineValid = config.forceIncludeTypesWithMissingCheck;
				break;
				
			case 'ManagedContentNodeType':
				//TODO: Figure out what local data here pulled from SF metadata can be checked to verify the existance of this type of thing.
				lineValid = config.forceIncludeTypesWithMissingCheck;
				break;
				
			case 'PathAssistantStepInfo':
				//TODO: Figure out what local data here pulled from SF metadata can be checked to verify the existance of this type of thing.
				lineValid = config.forceIncludeTypesWithMissingCheck;
				break;
				
			default: 
				log('No defenition for metadata type: ' + metadataType);
		}
	}catch(ex){
			log(`Erroring evaluating existance of local meta data. ${metadataType} ${objectName} ${elementName}  ${metadataParts} ${ex.message}`, true, "red");
			console.log('type: ' + metadataType);
			console.log('object: ' + objectName);
			console.log('element: ' + elementName);
			lineValid = false;
			if(config.pauseOnError) keypress();
	}
	return lineValid;
}



function encodeHtmlEntities(valueString){
	valueString = valueString.replace(/[&<>'"]/g, 
	tag => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      "'": '&#39;',
      '"': '&quot;'
    }[tag]));
	
	return valueString;
}
/**
* @description reads log files from the given directory and looks for any 'Invalid Key' errors as provided by Salesforce and returns them in an array. This array can then be used to create exclusions so that
* the erroring metadata lines won't be included during the next round of translation file generation. 
* @param {string} sourceDir the directory path (related to this script) where the Salesforce provided log files are located.
* @return {array} array of elements that were noted as 'Invalid Key's from the log files to be exlucded.
*/
async function processErrorLogEntries(sourceDir){
	log(`Processing error log invalid key entries.`,true);
	let errorElements = [];
	const files = await fs.promises.readdir( sourceDir );
	
	for( const file of files ) {
		
		const filePath = path.join( sourceDir, file );
	
		let fileData = fs.readFileSync(`${sourceDir}\\${file}`, 'utf-8', function (err) {
			log('Could not read error log file. Unable to process erroring elements' + err.message, true, "red");
			if(config.pauseOnError) keypress();
			return false;
		});	
		
		let logEntries = fileData.split("\n");
			
		//look at each log line now that've split it on newlines
		for(line of logEntries){
			
			//look to see if this is an invalid key line
			if(line.indexOf('Invalid key: ') > -1 || line.indexOf('Invalid key ') > -1) {
				let cleanedLine = line;
				//if so, trim the content around the offending element
				cleanedLine = cleanedLine.replace('Invalid key: ','');
				cleanedLine = cleanedLine.replace('Invalid key ','');
				cleanedLine = cleanedLine.replace('[','');
				cleanedLine = cleanedLine.replace(']','')
				cleanedLine = cleanedLine.replace('. The key\'s translation type must match the file\'s translation type. ,','').trim();
				cleanedLine = cleanedLine.replace(': Some keys are appended with their sort order for uniqueness. Re-export your file and ensure that the keys in both files match.,','').trim();
				errorElements.push(cleanedLine);
			}
		}
	}
	
	errorElements = [...new Set(errorElements)].sort();
	
	fs.writeFileSync('invalidTranslationEntries.json', JSON.stringify(errorElements, null, 2), function(err){
		if(err) {
			return log(err);
		}
		log("The invalidTranslationEntries.json file was saved!");
	})
	
	log(`Found ${errorElements.length} Invalid Key entries to remove.`,true);
	return errorElements;
}

/**
* @description reads the custom labels from from the local file system project folder and loads it into memory so it can be quickly searched.
*/
function loadCustomLabelsIntoMemory(){
	log(`Loading custom labels data from ${config.orgDataLocation}\\labels\\CustomLabels.labels-meta.xml`,true);
	
	let fileData = fs.readFileSync(`${config.orgDataLocation}\\labels\\CustomLabels.labels-meta.xml`, 'utf-8', function (err) {
		log('Could not load custom labels file into memory. Custom label translation analysis will not work' + err.message, true, "red");
		if(config.pauseOnError) keypress();
		return false;
	});	
	
	log(`Custom labels loaded`,true,'green');
	return true;
}


/**
* @description reads the address settings (addressState, addressCountry) from from the local file system. The resulting data converted into JSON 
* keyed by the country Iso Code, with it's states being members in the statesByCode property.
* 
*/
async function loadAddressData(){
	let addressObj = {};
	
	try{
		log(`Loading address data from ${config.orgDataLocation}\\settings\\Address.settings-meta.xml`);
		
		let fileData = fs.readFileSync(`${config.orgDataLocation}\\settings\\Address.settings-meta.xml`, 'utf-8', function (err) {
			log('Could not load address settings file into memory. Address translation analysis will not work. Fetch from metadata API with <types><members>Address</members><name>Settings</name></types>' + err.message, true, "red");
			if(config.pauseOnError) keypress();
			return false;
		});	
		
		let addressDataObject = await xmlToJson(fileData);
		
		
		//For our purposes we want the data keyed by country ISO code, then state ISO code. So lets do that now.
		for(country of addressDataObject.AddressSettings.countriesAndStates[0].countries){
			let thisCountryIsoCode = country.isoCode[0];
			
			addressObj[thisCountryIsoCode] = {}; //country;
			
			addressObj[thisCountryIsoCode].statesByCode = {};
			
			if(country.states ){
				for(state of country.states){				
					addressObj[thisCountryIsoCode].statesByCode[state.isoCode[0]] = state;
				}
			}
		}
		
		fs.writeFileSync('addressData.json', JSON.stringify(addressObj, null, 2), function(err){
			if(err) {
				return log(err);
			}
			log("The addressData.json file was saved!");
		});
		
		log(`Address data loaded`,true,'green');
	}catch(ex){
		log('Error loading address data. ' + ex.message,true,'red');
		if(config.pauseOnError) keypress();
	}
	return addressObj;
	
}

/**
* @description iterates over the translation files in the given directory and sends them for cleaning.
* @param {string} sourceDir the local folder the translation files (.stf or xlf are located).
* @param {string} destDir the local folder the cleaned files should be written to
* @param {string} fileType the file type filter to use to only process files of the given type. Should be .stf or .xlf.
*/
async function generateFinalReport(sourceDir='translationLogs', fileType='.log') {
	log(`Reading ${fileType} files from ${sourceDir}`,true);
	
	let promises = [];
	
	try {
        // Get the files as an array
        let files = await fs.promises.readdir( sourceDir );

		//filter the files to only get the types we are interested in.
		files = files.filter(file => {
			return path.extname(file).toLowerCase() === fileType;
		});

        // Loop them all
		let logs = {};
        for( const file of files ) {
            // Get the full paths
            const sourcePath = path.join( sourceDir, file );

            // Stat the file to see if we have a file or dir
            const stat = await fs.promises.stat( sourcePath );

            if( stat.isFile()){		
				let fileData = fs.readFileSync(`${sourceDir}\\${file}`, 'utf-8', function (err) {
					log('Could not read error log file. Unable to process erroring elements' + err.message, true, "red");
					return false;
				});
				
				logEntry = JSON.parse(fileData);				
				logs[logEntry.details.languageCode] = logs.hasOwnProperty(logEntry.details.languageCode) ? sumObjectsByKey(logs[logEntry.details.languageCode], logEntry.details) : logEntry.details;
			}
        }
		
		let reportCsvContent = ['Language,LanguageCode,TotalEntries,ValidEntries,InvalidEntries,ValidPercent,InvalidPercent'];
		for (let [key, l] of Object.entries(logs)) {
			reportCsvContent.push(`${l.language},${l.languageCode},${l.total},${l.valid},${l.invalid},${Math.round((l.valid/l.total)*100)},${Math.round((l.invalid/l.total)*100)}`);
		}
		
		fs.writeFileSync('Translation Cleaning Final Report.csv', reportCsvContent.join('\r\n'), function(err){
			if(err) {
				return log(err);
			}
			log("The Translation Cleaning Final Report.csv file was saved!");
		});	
		
		
		log('Wrote finaly report',true,'green');
		
    }
    catch( e ) {
        log( "Error reading source translation files to send for processing " + e.message, true, 'red' );
    }

	//once all promises the from the cleanStfFile function calls are resolved then log them. This doesn't seem to work quite right as I don't think the the cleanStfFile function is resolving/returning its
	//promises correctly.
	return Promise.all(promises);
}

function sumObjectsByKey(...objs) {
  return objs.reduce((a, b) => {
    for (let k in b) {
      if (b.hasOwnProperty(k) && typeof b[k] === 'number' )
        a[k] = (a[k] || 0) + b[k];
	  else
		  a[k] = b[k];
    }
    return a;
  }, {});
}

function wildcardStringSearch(wildcard, str) {
  let w = wildcard.replace(/[.+^${}()|[\]\\]/g, '\\$&'); // regexp escape 
  const re = new RegExp(`^${w.replace(/\*/g,'.*').replace(/\?/g,'.')}$`,'i');
  return re.test(str); // remove last 'i' above to have case sensitive
}
/**
* @description reads cached data and returns it. If requested data is loaded into memory (cached) it's returned directly. If not, the source data is read from the corresponding file. 
* This function supports reading of cache data for type: PicklistValue, WorkflowTask and DataCategory. 
* @param {string} type The type of thing to read cached data for. Should be one of the following:  PicklistValue, WorkflowTask and DataCategory. 
* @param {string} objectName the object name related to the type. Such as 'Case' for type 'PicklistValue' to get picklist values on the Case object.
* @param {string} elementName the name of the field related to the objectName. Such as 'Status' for objectName 'Case'. Not required for WorkflowTask or DataCategory. 
* @return {object} the data either fetched from or now stored in the cache for the requested type/object/field.
*/

async function zipResults(fileName, outputFolder){ 

	log(`Zipping folder ${outputFolder} to ${fileName}.zip`,true); 
	let zipResults = runCommand(`7z a "${fileName}" ./${outputFolder}/* -r -tzip`);
	
	log(zipResults,true); 
	
	return true;
}

/**
 * @Description Runs a shell command.
 * @Param command the name of the command to execute WITHOUT any arguments.
 * @Param arguments an array of arguments to pass to the command.
 * @Return javascript promise object that contains the result of the command execution
 */
function runCommand(command, arguments = [], nolog) {
	if(!nolog) log(command +  ' ' + arguments.join(' '));
    let p = spawn(command, arguments, { shell: true, windowsVerbatimArguments: true });
    return new Promise((resolveFunc) => {
		var output ='';
        p.stdout.on("data", (x) => {
            //process.stdout.write(x.toString());
            if(!nolog) log(x.toString());
			output += x;
        });
        p.stderr.on("data", (x) => {
			//process.stderr.write(x.toString());
            if(!nolog) log(x.toString());
			output += x;
        });
        p.on("exit", (code) => {
			let returnObject = {'exit_code': code, 'output': output};
			if(!nolog) log('Command complete. Result: ' + JSON.stringify(returnObject, null, 2),false);
            resolveFunc(returnObject);
        });
    });
}

function getCachedData(type,objectName,elementName){
	
	console.log('Tryingto get cached data for ' + type + ' ' + objectName + ' ' + elementName);
	if(type && objectName && elementName && cachedFileData?.[type]?.[objectName]?.[elementName]){
		//console.log(`Returning cached value for ${type} ${objectName} ${elementName}`);
		return cachedFileData[type][objectName][elementName];
	}else if(type && objectName && !elementName && cachedFileData?.[type]?.[objectName]){
		//console.log(`Returning cached value for ${type} ${objectName}`);
		return cachedFileData[type][objectName];
	}else if(type && !objectName && !elementName && cachedFileData?.[type]){
		//console.log(`Returning cached value for ${type}`);
		return cachedFileData[type];
	}
	
	let returnData;
	
	switch(type) {
		case 'PicklistValue':
			returnData = readFile(`${config.orgDataLocation}\\objects\\${objectName}\\fields\\${elementName}__c.field-meta.xml`);
			break;
		case 'WorkflowTask':
			returnData = readFile(`${config.orgDataLocation}\\workflows\\${objectName}.workflow-meta.xml`);
			break;	
		case 'DataCategory':
			returnData = readFile(`${config.orgDataLocation}\\datacategorygroups\\${objectName}.datacategorygroup-meta.xml`); 
			break;
		case 'RecordType':
			returnData = readFile(`${config.orgDataLocation}\\objects\\${objectName}\\recordTypes\\${elementName}.recordType-meta.xml`);
			break;
		case 'Flow':
			returnData = readFile(`${config.orgDataLocation}\\flows\\${elementName}.flow-meta.xml`);
			break;
		default:
			log('No method for getting stored data for type '+type+' defined. The metadata type cannot current be read/cached',true,'red');
	}

	log(`Cache miss - Fetched fresh value from file for for ${type} ${objectName} ${elementName}`,true,'yellow');
		
	if(returnData){
		if(!cachedFileData.hasOwnProperty(type)) cachedFileData[type] = {};
		if(!cachedFileData[type].hasOwnProperty(objectName)) cachedFileData[type][objectName] = {};
		
		if(elementName) cachedFileData[type][objectName][elementName] = returnData;
		else cachedFileData[type][objectName] = returnData; 
	}
	
	return returnData;
}

function writeXmlFromJSON(jsonObject, targetFolder, file){
	console.log('Constructing XML from JSON');
	console.log(jsonObject);
	
	var builder = new xml2js.Builder();
	var xml = builder.buildObject(jsonObject);

	fs.writeFileSync(`${targetFolder}\\${file}`, xml, function(err){
		if(err) {
			return log(err);
		}
	});
	
	log(`${targetFolder}\\${file} file was saved!`);
}

//Checks if a file exists
function fileExists(filePath){
	log('Looking for file ' + filePath);
	if (!fs.existsSync(filePath)) {
		log('File not found!', true, 'yellow');
		return false;
	}
	log('File Found', true, 'green');
	return true;
}

function readFile(filePath){
	log('Reading file ' + filePath,true);

	let fileData = fs.readFileSync(filePath, 'utf-8', function (err) {
		log("File not found or unreadable." + err.message, true, "red");
	});

	log('File Found', true, 'green');
	return fileData;
}
/**
 * @Description Parses the raw HTML content fetched by getOutboundChangeSets() to return an array containing all the change set names.
 * @Param html a string of HTML that contains the change set names fetched from the Salesforce UI
 * @Return
 */
function loadConfig(configFileName) {
    return readJSONFromFile(configFileName);
}

/**
* @Description writes the current working config back into the config.json file
*/
function saveConfig(){
	fs.writeFileSync('config.json', JSON.stringify(config, null, 2), function(err){
		if(err) {
			return log(err);
		}
		log("The file was saved!");
	});
}

/**
 * @Description Reads and parses JSON from a given file.
 * @Param fileName the name of the file to read, parse, and return.
 * @Return a JSON object.
 */
function readJSONFromFile(fileName) {
    let fileJSON = fs.readFileSync(fileName, 'utf-8', function (err) {
        log("File not found or unreadable. Skipping import" + err.message, true, "red");
        return null;
    });

	//strip any comments from our JSON sting
	fileJSON = fileJSON.replace(/\\"|"(?:\\"|[^"])*"|(\/\/.*|\/\*[\s\S]*?\*\/)/g, (m, g) => g ? "" : m);
    const parsedJSON = JSON.parse(fileJSON);
    return parsedJSON;
}


async function xmlToJson(xml){
	var parser = new xml2js.Parser();
	return parser.parseStringPromise(xml);
}

function writeTranslationFile(destFolder, fileName, lines=[]){
	try{
		fs.writeFileSync(destFolder+'\\'+fileName, lines?.join('\r\n'), 'utf8', function(){;
			log('Wrote file ' + destFolder + '\\' + fileName, true, 'green');
		});
	}catch(ex){
		
		console.log(ex);
		console.log(destFolder);
		console.log(fileName);
		console.log(typeof lines);
		if(typeof lines == 'string'){
			console.log('Lines variable is a string for some reason....');
			console.log(lines.substring(0,1000));
		}
	}
}
/**
* @Description clears the terminal screen.
*/
function clearScreen(){
	console.log('\033[2J');
	process.stdout.write('\033c');
}

/**
 * @Description Creates a log entry in the log file, and optionally displays log entry to the terminal window with requested color.
 * @Param logItem a string of data to log
 * @Param printToScreen boolean flag indicating if this entry should be printed to the screen (true) or only to the log file (false)
 * @Param a string {'red','green','yellow'} that indicates what color the logItem should be printed in on the screen..
 */
function log(logItem, printToScreen, color) {
    printToScreen = printToScreen != null ? printToScreen : true;
    var colorCode = "";
    switch (color) {
        case "red":
            colorCode = "\x1b[31m";
            break;
        case "green":
            colorCode = "\x1b[32m";
            break;
        case "yellow":
            colorCode = "\x1b[33m";
    }

    if (printToScreen) console.log(colorCode + "" + logItem + "\x1b[0m");

	logEntries.push(logItem);
	
	if(color === 'red') errorLogEntries.push(logItem);
}

/**
* @Description Method that executes at the end of a script run. Writes to the log file. Exits the program.
*/
function finish() {
    log("Process completed. Writting " + logEntries.length + " log entries", true, "yellow");
	
;
	
    log("\r\n\r\n------------------------------------------------ ", false);
	
    fs.writeFileSync("log.txt", logEntries.join("\r\n"), function (err) {
        if (err) {	
			console.log('Unable to write to log file');
			console.log(err);
		}
    });
    fs.writeFileSync("errors.txt", errorLogEntries.join("\r\n"), function (err) {
        if (err) {	
			console.log('Unable to write to error log file');
			console.log(err);
		}
    });
	
	let d = new Date();
    d.toLocaleString();

    log("Finished process at " + d, true)
	process.exit(1);
}

/**
 * @Description Method that executes on an uncaught error.
*/
process.on("uncaughtException", (err) => {
    log(err, true, "red");
	console.trace(err);
	finish();
});

init();