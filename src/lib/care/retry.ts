/** Component-lifetime IDs only: never persist clinical drafts in browser storage. */
export class RetryIds {
  private attempts=new Map<string,{payload:string;id:string}>();
  id(operation:string,payload:string):string {
    const previous=this.attempts.get(operation);
    if(previous?.payload===payload)return previous.id;
    const id=crypto.randomUUID();this.attempts.set(operation,{payload,id});return id;
  }
  confirmed(operation:string){this.attempts.delete(operation);}
}
