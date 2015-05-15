console.log('Loading');

var aws = require("aws-sdk");

exports.handler = function (event, context) {
    /// <summary>Handles CloudFormation CustomResource requests.</summary>
    /// <param name='event' value='{RequestType:"",ResourceType:""}'>Event raised.</param>
    /// <returns value="null">Nothing.</returns>
    
    if (!event) {
        context.fail('No event object');
        context.done();
    }
    
    console.log("Request Event:" + JSON.stringify(event));
    console.log("Request Context:" + JSON.stringify(context));

    var w = new worker(event, context);
    
	if ( event["Records"] ){
        console.log("Processing SNS event");
		var records = [];
		event.Records.forEach(function (x) { records.push(x); });
		w.startProcessRecords(records, function(err) {
			if (err){
				console.log("Record error:" + JSON.stringify(err));
				context.fail(err);
				}
			else
				console.log("ok");
			context.done();
			});
		return;
	}
	
	if ( !event["RequestType"]){
        console.log("Not a cloudformation event");
		context.fail("Not a cloudformation event");
        context.done();
        return;
    }
    
	
    if (event.RequestType == "Delete") {
        sendResponse(event, context, "SUCCESS");
        return;
    }
    
    w.startCustomResource(function (err, data) {
        if (err) {
            sendErrorResponse(event, context, { Error: err });
            return;
        }
        sendResponse(event, context, "SUCCESS", data);
    });
};

function GetAccountIdFromArn(arn){
    return arn.replace(/^arn:aws:([^:]+):([^:]*):([0-9]+):.*$/, "$3");
}
function GetRegionFromArn(arn){
    return arn.replace(/^arn:aws:([^:]+):([^:]*):([0-9]+):.*$/, "$2");
}


function worker(event, context) {
    if (!(this instanceof worker))
        return new worker(event, context);
    this.event = event;
    this.context = context;
    this.ec2 = new aws.EC2();
    
	this.expr = null;
	this.excludeExpr = false;

    var that = this;

	
	this.startProcessRecords = function (records, cb)
	{
		if (records.length === 0 ) {
			process.nextTick(function () { cb(null, null); });
			return;
		}
		var record = records.pop();
		that.startProcessRecords(records, function(err, data) {
			if ( err ){
				cb(err,null);
				return;
			}
			that.processRecord(record, function(err, data) {
				cb(err, data);
			});
		});
	};

	this.processRecord = function (record, cb)
	{
		if ( record.EventSource == "aws:sns" ){
			var msg;
			try{
				msg = JSON.parse(record.Sns.Message);
			}
			catch(e)
			{
				cb("Record Parse Error:" + e.toString());
				return;
			}
			console.log("Event:", msg.Event);
			if ( msg.Event == "autoscaling:EC2_INSTANCE_LAUNCH" ){
				var arn = msg.AutoScalingGroupARN;
				var region = GetRegionFromArn(arn);
				that.ec2 = new AWS.EC2({region: region});
				that.processInstanceId( msg.EC2InstanceId, function(err, data) {
					cb(err,data);
					});
				return;
			}
			cb(null);
		}
		else{
			cb({"Error": "Unknown event source" });
		}
	};

	
    this.startCustomResource = function (cb) {
		var stackId = event.StackId;
		var region = GetRegionFromArn(stackId);
		that.ec2 = new AWS.EC2({region: region});
		var expr = event.ResourceProperties.Match;
		if (expr) {
			that.expr = new RegExp(expr);
			that.excludeExpr = !!event.ResourceProperties.ExcludeMatch;
		}
        if (event.ResourceProperties.InstanceId) {
            this.processInstanceId(event.ResourceProperties.InstanceId, cb);
        }
        else if (event.ResourceProperties.InstanceIds) {
            this.processInstanceIds(event.ResourceProperties.InstanceIds, function (err, data) {
                if (data) data = { "Instances": data }; cb(err, data);
            });
        }
        else
            process.nextTick(function () { cb({ "Error": "No instance supplied" }) });
    };
    
    this.processInstanceIds = function (instanceIds, cb) {
        if (instanceIds.length === 0) {
            process.nextTick(function () { cb(null, []); });
            return;
        }
        var instance = instanceIds.pop();
        that.processInstanceIds(instanceIds, function (err, data) {
            if (err) {
                cb(err, data);
                return;
            }
            that.processInstanceId(instance, function (err, dataI) {
                if (err) {
                    err = { "Error": "Error processing instance:" + instance, "From": err };
                    cb(err, data);
                }
                else {
                    data.push(dataI);
                    cb(err, data);
                }
            });
        });
    };
    
    this.processInstanceId = function (InstanceId, cb) {
        that.ec2.describeInstances({ InstanceIds : [InstanceId] }, function (err, data) {
            if (err) {
                err = { "Error": "Error in describeInstances for InstanceId" + InstanceId, "From": err };
                cb(err, null);
                return;
            }
            if (data.Reservations.length === 0) {
                cb({ "Error": "Instance not found:" + InstanceId }, null);
                return;
            }
            var instance = data.Reservations[0].Instances[0];
            that.processInstance(instance, function (err, data) {
                cb(err, data);
            });
        });
    };
    
    this.processInstance = function (instance, cb) {
        var volIds = [];
        instance.BlockDeviceMappings.forEach(function (x) { volIds.push(x.Ebs.VolumeId); });
        that.ec2.describeVolumes({ VolumeIds: volIds }, function (err, data) {
            if (err) {
                err = { "Error": "describeVolumes for vol:" + volIds.join(","), "From:": err };
                cb(err, null);
                return;
            }
            var ebsArray = [];
            data.Volumes.forEach(function (x) { ebsArray.push(x); });
            that.processEbs(instance, ebsArray, function (err, data) {
                if (!err)
                    data = { "InstanceId" : instance.InstanceId, "Volumes" : data };
                cb(err, data);
            });
        });
    };
    
    this.processEbs = function (instance, ebsArray, cb) {
        if (ebsArray.length === 0) {
            process.nextTick(function () { cb(null, null); });
            return;
        }
        var ebs = ebsArray.pop();
        
        that.processEbs(instance, ebsArray, function (err, data) {
            if (err) {
                cb(err, data);
                return;
            }
            if (!data)
                data = [];
            
            var tags = [];
            
            instance.Tags.forEach(function (tag) {
                var key = tag.Key;
                
                if (that.expr) {
                    var match = that.expr.test(key);
                    if (that.excludeExpr)
                        match = !match;
                    if (!match)
                        return;
                }
                
                if (key.substring(0, 4) == "aws:") key = "_" + key;
                var found = false;
                ebs.Tags.forEach(function (tag2) { if (key == tag2.Key) found = true; });
                if (!found)
                    tags.push({ Key: key, Value: tag.Value });
            });
            
            if (tags.length > 0) {
                that.ec2.createTags({ Resources: [ebs.VolumeId], Tags: tags }, function (err, dataCT) {
                    if (err) {
                        err = { "Error" : "createTags error on vol:" + ebs.VolumeId, "From": err };
                        cb(err, null);
                    }
                    else {
                        data.push({ "VolumeId" : ebs.VolumeId, "Tags": tags });
                        cb(err, data);
                    }
                });
            }
            else {
                process.nextTick(function () { cb(null, data); });
            }
        });
    };
}

function sendErrorResponse(event, context, err) {
    console.log(err);
    sendResponse(event, context, "FAILED", err);
}


function sendResponse(event, context, responseStatus, responseData) {
    /// <summary>Sends response to the pre-signed S3 URL</summary>
    /// <param name="event">handler event</param>
    /// <param name="context">handler context</param>
    var responseBody = JSON.stringify({
        Status: responseStatus,
        Reason: "See the details in CloudWatch Log Stream: " + context.logStreamName,
        PhysicalResourceId: event.StackId.replace(/^.*:stack\//, "") + "-" + event.LogicalResourceId, //context.logStreamName,
        StackId: event.StackId,
        RequestId: event.RequestId,
        LogicalResourceId: event.LogicalResourceId,
        Data: responseData
    });
    
    console.log("RESPONSE BODY:\n", responseBody);
    if ( len(responseBody) > 4096 ){
		console.log("Warning RESPONSE BODY too long:\n", len(responseBody));
	}
	
    if (event.RequestType == "Test") {
        context.succeed(responseBody);
        context.done();
        return;
    }
    
    var https = require("https");
    var url = require("url");
    
    var parsedUrl = url.parse(event.ResponseURL);
    var options = {
        hostname: parsedUrl.hostname,
        port: 443,
        path: parsedUrl.path,
        method: "PUT",
        headers: {
            "content-type": "",
            "content-length": responseBody.length
        }
    };
    
    var request = https.request(options, function (response) {
        console.log("STATUS: " + response.statusCode);
        console.log("HEADERS: " + JSON.stringify(response.headers));
        // Tell AWS Lambda that the function execution is done  
        context.done();
    });
    
    request.on("error", function (error) {
        console.log("sendResponse Error:\n", error);
        // Tell AWS Lambda that the function execution is done  
        context.fail(error);
        context.done();
    });
    
    // write data to request body
    request.write(responseBody);
    request.end();
}

