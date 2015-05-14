# AWS-UpdateEBSTags
AWS Lambda script that updates EBS volume tags copied from the Instance on cloudformation and Auto scaling creation

Add this to you cloudformation script for the lambda function to copy the EBS tags from the instance, you can add Match regexp and ExcludeMatch flag to control which tags are copied. 

	"UpdateEbs": {
		"Type" : "AWS::CloudFormation::CustomResource",
        "Properties" : {
			"ServiceToken":"arn:aws:lambda:eu-west-1:123123123123:function:UpdateEBSTags",
			"InstanceIds":[ { "Ref" : "AppInstance" } ]
			}
	},

Also you can use SNS notification from an Autoscaling group to update launched instance.
